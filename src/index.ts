import { parseArgs } from "node:util";
import { atomicWriteFile } from "./atomic-write.js";
import { toCsv } from "./csv.js";
import { inferProvider } from "./providers.js";
import { pickBackupOwner, rankDeployers, resolveOwner } from "./owners.js";
import { describeSource, promptTokenHidden, readTokenFromFile, resolveToken } from "./prompt-token.js";
import { recommendFor } from "./recommendation.js";
import { selectTeams } from "./team-select.js";
import { VercelClient, VercelRequestError, type EnvVar, type EnvVarType, type Project, type Team } from "./vercel.js";

const ROTATE_TYPES = new Set<EnvVarType>(["plain", "encrypted", "secret"]);
const SKIP_TYPES = new Set<EnvVarType>(["sensitive", "system"]);

const HEADERS = [
	"team_name",
	"team_slug",
	"project_name",
	"project_id",
	"env_id",
	"configuration_id",
	"key",
	"type",
	"targets",
	"git_branch",
	"provider",
	"recommendation",
	"primary_owner_name",
	"primary_owner_email",
	"backup_owner_name",
	"backup_owner_email",
	"backup_deploy_count_90d",
	"last_updated_at",
	"last_updated_days_ago",
	"created_at",
	"vercel_url",
] as const;

type ReportRow = Record<(typeof HEADERS)[number], string>;

type ScanError = { teamSlug: string; projectName: string; projectId: string; stage: string; message: string };

type ParsedArgs = {
	team: string | undefined;
	allTeams: boolean;
	projectFilters: string[];
	tokenFlag: string | undefined;
	tokenFile: string | undefined;
	out: string;
	lookbackDays: number;
	includeVercelPrefixed: boolean;
	logRequests: boolean;
	dryRun: boolean;
};

function parseCli(): ParsedArgs {
	const { values } = parseArgs({
		options: {
			team: { type: "string" },
			"all-teams": { type: "boolean", default: false },
			project: { type: "string", multiple: true },
			token: { type: "string" },
			"token-file": { type: "string" },
			out: { type: "string", default: "rotation-report.csv" },
			"lookback-days": { type: "string", default: "90" },
			"include-vercel-prefixed": { type: "boolean", default: false },
			"log-requests": { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		printHelp();
		process.exit(0);
	}

	const lookbackDays = Number.parseInt(values["lookback-days"] as string, 10);
	if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) {
		fail("--lookback-days must be a positive integer");
	}

	return {
		team: values.team as string | undefined,
		allTeams: Boolean(values["all-teams"]),
		projectFilters: (values.project as string[] | undefined) ?? [],
		tokenFlag: values.token as string | undefined,
		tokenFile: values["token-file"] as string | undefined,
		out: (values.out ?? "rotation-report.csv") as string,
		lookbackDays,
		includeVercelPrefixed: Boolean(values["include-vercel-prefixed"]),
		logRequests: Boolean(values["log-requests"]),
		dryRun: Boolean(values["dry-run"]),
	};
}

/**
 * Token acquisition (real CLI wiring on top of the pure `resolveToken` policy).
 *   1. --token-file <path>   (- means stdin)
 *   2. $VERCEL_TOKEN
 *   3. --token <t>           (warns — visible to ps)
 *   4. Interactive hidden-input prompt (TTY only)
 */
async function acquireToken(args: ParsedArgs): Promise<string> {
	try {
		const result = await resolveToken(
			{
				tokenFile: args.tokenFile,
				tokenFlag: args.tokenFlag,
				envToken: process.env["VERCEL_TOKEN"],
				isTty: Boolean(process.stdin.isTTY),
			},
			{
				readFile: readTokenFromFile,
				prompt: () => promptTokenHidden("Vercel API token (input hidden): "),
				warn: (msg) => process.stderr.write(`WARNING: ${msg}\n`),
			},
		);
		process.stderr.write(`Token source: ${describeSource(result.source)}\n`);
		return result.token;
	} catch (err) {
		fail((err as Error).message);
	}
}

function printHelp(): void {
	console.log(
		[
			"Usage: VERCEL_TOKEN=xxx npx tsx src/index.ts [options]",
			"",
			"Team selection:",
			"  If --team is omitted, the tool lists teams the token can access.",
			"  One team → selected silently. Multiple → interactive prompt",
			"  (unless --all-teams is given).",
			"",
			"Options:",
			"  --team <idOrSlug>           Vercel team ID or slug (optional)",
			"  --all-teams                 Scan every team the token can access",
			"  --project <idOrName>        Limit to one or more projects (repeatable)",
			"  --token-file <path>         Read token from a file (preferred over --token)",
			"  --token <token>             Vercel API token (DISCOURAGED: visible to ps)",
			"                              If --token-file is unset, $VERCEL_TOKEN is used.",
			"  --out <path>                Output CSV path (default: rotation-report.csv)",
			"  --lookback-days <n>         Deployment lookback for backup owner (default: 90)",
			"  --include-vercel-prefixed   Include env vars starting with VERCEL_ (default: skip)",
			"  --log-requests              Print every API request (method + path + query) to stderr",
			"  --dry-run                   List teams + projects that would be scanned, then exit",
			"  -h, --help                  Show this help",
			"",
			"Exit codes: 0 = clean, 1 = fatal error (no CSV), 2 = CSV written with per-project errors",
		].join("\n"),
	);
}

function fail(message: string): never {
	process.stderr.write(`Error: ${message}\n`);
	process.exit(1);
}

function log(line: string): void {
	process.stderr.write(`${line}\n`);
}

async function main(): Promise<void> {
	const args = parseCli();
	const token = await acquireToken(args);
	const client = new VercelClient(token, null, {
		logRequest: args.logRequests ? (line) => process.stderr.write(`[api] ${line}\n`) : undefined,
	});

	log("[1/5] Resolving accessible teams (preflight token check)...");
	let accessible: Team[];
	try {
		accessible = await client.listAccessibleTeams();
	} catch (err) {
		if (err instanceof VercelRequestError && (err.status === 401 || err.status === 403)) {
			fail(
				`Token rejected by Vercel (status ${err.status}). Common causes:\n` +
					`  - token is expired, revoked, or mistyped\n` +
					`  - token lacks the scope to read teams (Developer role or above is required)\n` +
					`  - token belongs to a different Vercel account than the one with team access\n` +
					`Create a fresh token at https://vercel.com/account/tokens and retry.`,
			);
		}
		throw err;
	}
	const { teams, mode } = await selectTeams(accessible, {
		explicitTeam: args.team,
		allTeams: args.allTeams,
	});
	log(
		`  ${mode === "all" ? "scanning all" : "scanning"} ${teams.length} team${teams.length === 1 ? "" : "s"}: ${teams.map((t) => t.slug).join(", ")}`,
	);

	if (args.dryRun) {
		log("\n--dry-run: listing projects per team and exiting.");
		for (const team of teams) {
			client.setTeam(team.id);
			const projects = await client.listProjects();
			const filtered = filterProjects(projects, args.projectFilters);
			log(`\n  ${team.slug} (${projects.length} total, ${filtered.length} after --project filter)`);
			for (const p of filtered) log(`    - ${p.name} (${p.id})`);
		}
		return;
	}

	const typeCounts: Record<string, number> = {};
	const rows: ReportRow[] = [];
	const scanErrors: ScanError[] = [];
	let totalProjectsScanned = 0;
	const sinceMs = Date.now() - args.lookbackDays * 24 * 60 * 60 * 1000;

	for (const team of teams) {
		log(`\n=== Team: ${team.name} (${team.slug}) ===`);
		client.setTeam(team.id);

		log("  [2/5] Listing projects...");
		let projects: Project[];
		try {
			projects = await client.listProjects();
		} catch (err) {
			log(`  ! Failed to list projects for ${team.slug}: ${(err as Error).message}`);
			scanErrors.push({ teamSlug: team.slug, projectName: "<team>", projectId: "", stage: "projects", message: (err as Error).message });
			continue;
		}
		projects = filterProjects(projects, args.projectFilters);
		log(`    ${projects.length} projects${args.projectFilters.length > 0 ? " (after --project filter)" : ""}`);
		totalProjectsScanned += projects.length;

		// Team member directory is used to:
		//   (a) resolve `env.updatedBy` / `createdBy` UIDs to emails (primary_owner_email)
		//   (b) resolve `deployment.creator.uid` UIDs to names/emails (backup_owner_*)
		// Primary owner *names* come from the env var's own `lastEditedByDisplayName`
		// when present (populated even for users who have left the team). If this
		// call fails, the scan still produces rows — just without owner emails and
		// with UIDs in place of backup-owner names.
		log("  [3/5] Fetching team members (to resolve owner UIDs → emails on each row)...");
		let members: Map<string, import("./vercel.js").TeamMember>;
		try {
			members = await client.listTeamMembers();
			log(`    ${members.size} members`);
		} catch (err) {
			log(`  ! team members fetch failed for ${team.slug} (${(err as Error).message}); continuing with UID-only owner columns`);
			scanErrors.push({
				teamSlug: team.slug,
				projectName: "<team>",
				projectId: "",
				stage: "members",
				message: `${(err as Error).message} — continued with UID-only owner columns`,
			});
			members = new Map();
		}

		log(`  [4/5] Inventorying env vars and deploy history (lookback ${args.lookbackDays}d)...`);
		for (const project of projects) {
			let envs: EnvVar[];
			try {
				envs = await client.listProjectEnv(project.id);
			} catch (err) {
				scanErrors.push({
					teamSlug: team.slug,
					projectName: project.name,
					projectId: project.id,
					stage: "env",
					message: (err as Error).message,
				});
				log(`    ! env fetch failed for ${project.name}: ${(err as Error).message}`);
				continue;
			}

			const rotatable = envs.filter((e) => shouldRotate(e, args.includeVercelPrefixed));
			typeCountsTally(envs, typeCounts);

			let rankedDeployers: string[] = [];
			let deployCounts = new Map<string, number>();
			if (rotatable.length > 0) {
				try {
					const deployments = await client.listDeployments(project.id, sinceMs);
					const ranking = rankDeployers(deployments);
					rankedDeployers = ranking;
					deployCounts = countDeploys(deployments);
				} catch (err) {
					scanErrors.push({
						teamSlug: team.slug,
						projectName: project.name,
						projectId: project.id,
						stage: "deployments",
						message: (err as Error).message,
					});
					log(`    ! deployments fetch failed for ${project.name}: ${(err as Error).message}`);
					// Continue with env rows but without backup owner data.
				}
			}

			for (const env of rotatable) {
				// Prefer updatedBy; fall back to createdBy if the env var has never been edited.
				const primaryUid = env.updatedBy ?? env.createdBy;
				const resolved = resolveOwner(primaryUid, members);
				// Vercel ships a human-readable display name on every env var, which
				// survives even after the user leaves the team. Prefer it for the
				// name column; fall back to member-map resolution.
				const primary = {
					uid: resolved.uid,
					name: env.lastEditedByDisplayName ?? resolved.name,
					email: resolved.email,
				};
				const backup = pickBackupOwner(rankedDeployers, primaryUid, members);
				const backupDeploys = backup ? deployCounts.get(backup.uid) ?? 0 : 0;
				rows.push(buildRow(team, project, env, primary, backup, backupDeploys));
			}
		}
	}

	rows.sort((a, b) => {
		if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
		if (a.team_slug !== b.team_slug) return a.team_slug.localeCompare(b.team_slug);
		if (a.project_name !== b.project_name) return a.project_name.localeCompare(b.project_name);
		return a.key.localeCompare(b.key);
	});

	log("\n[5/5] Writing CSV...");
	const csv = toCsv(HEADERS, rows);
	atomicWriteFile(args.out, csv);
	log(`  wrote ${args.out}`);

	if (scanErrors.length > 0) {
		const errPath = `${args.out}.scan-errors.txt`;
		const body = scanErrors
			.map((e) => `[${e.stage}] ${e.teamSlug} :: ${e.projectName} (${e.projectId}): ${e.message}`)
			.join("\n");
		atomicWriteFile(errPath, `${body}\n`);
		log(`  ${scanErrors.length} error(s) encountered → ${errPath}`);
	}

	printSummary(teams.length, totalProjectsScanned, typeCounts, rows, args.out, scanErrors.length);

	process.exit(scanErrors.length > 0 ? 2 : 0);
}

function filterProjects(projects: readonly Project[], filters: readonly string[]): Project[] {
	if (filters.length === 0) return [...projects];
	const set = new Set(filters);
	return projects.filter((p) => set.has(p.id) || set.has(p.name));
}

function shouldRotate(env: EnvVar, includeVercelPrefixed: boolean): boolean {
	if (!ROTATE_TYPES.has(env.type)) return false;
	if (!includeVercelPrefixed && env.key.startsWith("VERCEL_")) return false;
	return true;
}

function typeCountsTally(envs: readonly EnvVar[], tally: Record<string, number>): void {
	for (const env of envs) {
		tally[env.type] = (tally[env.type] ?? 0) + 1;
	}
}

function countDeploys(deployments: readonly import("./vercel.js").Deployment[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const d of deployments) {
		const uid = d.creator?.uid;
		if (!uid) continue;
		counts.set(uid, (counts.get(uid) ?? 0) + 1);
	}
	return counts;
}

function buildRow(
	team: Team,
	project: Project,
	env: EnvVar,
	primary: ReturnType<typeof resolveOwner>,
	backup: ReturnType<typeof pickBackupOwner>,
	backupDeploys: number,
): ReportRow {
	const provider = inferProvider(env.key);
	const recommendation = recommendFor(env, provider);
	const lastUpdatedMs = env.updatedAt ?? undefined;
	const daysAgo = lastUpdatedMs ? Math.floor((Date.now() - lastUpdatedMs) / (24 * 60 * 60 * 1000)) : "";
	const vercelUrl = `https://vercel.com/${team.slug}/${project.name}/settings/environment-variables`;
	return {
		team_name: team.name,
		team_slug: team.slug,
		project_name: project.name,
		project_id: project.id,
		env_id: env.id,
		configuration_id: env.configurationId ?? "",
		key: env.key,
		type: env.type,
		targets: (env.target ?? []).join("|"),
		git_branch: env.gitBranch ?? "",
		provider,
		recommendation,
		primary_owner_name: primary.name,
		primary_owner_email: primary.email,
		backup_owner_name: backup?.name ?? "",
		backup_owner_email: backup?.email ?? "",
		backup_deploy_count_90d: backup ? String(backupDeploys) : "",
		last_updated_at: lastUpdatedMs ? new Date(lastUpdatedMs).toISOString() : "",
		last_updated_days_ago: String(daysAgo),
		created_at: env.createdAt ? new Date(env.createdAt).toISOString() : "",
		vercel_url: vercelUrl,
	};
}

function printSummary(
	teamCount: number,
	projectCount: number,
	typeCounts: Record<string, number>,
	rows: readonly ReportRow[],
	outPath: string,
	errorCount: number,
): void {
	const totalEnvs = Object.values(typeCounts).reduce((a, b) => a + b, 0);
	log(
		`\nScanned ${teamCount} team${teamCount === 1 ? "" : "s"}, ${projectCount} projects, ${totalEnvs} env vars.`,
	);
	for (const t of ["sensitive", "system", "plain", "encrypted", "secret"] as const) {
		const count = typeCounts[t] ?? 0;
		const note = SKIP_TYPES.has(t) ? "(skipped)" : "→ report";
		log(`  ${t}: ${count} ${note}`);
	}

	// Per-provider rollup
	const perProvider = new Map<string, number>();
	for (const r of rows) perProvider.set(r.provider, (perProvider.get(r.provider) ?? 0) + 1);
	log("\nRows by provider:");
	for (const [p, n] of [...perProvider.entries()].sort((a, b) => b[1] - a[1])) {
		log(`  ${p}: ${n}`);
	}

	// Per-recommendation rollup
	const perRec = new Map<string, number>();
	for (const r of rows) perRec.set(r.recommendation, (perRec.get(r.recommendation) ?? 0) + 1);
	log("\nRows by recommendation:");
	for (const [r, n] of [...perRec.entries()].sort((a, b) => b[1] - a[1])) {
		log(`  ${r}: ${n}`);
	}

	log(`\nReport: ${outPath} (${rows.length} rows, ${perProvider.size} providers)`);
	if (errorCount > 0) log(`  (${errorCount} per-project errors logged to ${outPath}.scan-errors.txt)`);
}

main().catch((err: unknown) => {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
