const API_BASE = "https://api.vercel.com";
const RATE_LIMIT_DELAY_MS = 100;
const RETRY_AFTER_MAX_SECONDS = 60;
const RETRY_AFTER_DEFAULT_SECONDS = 5;

export type EnvVarType = "plain" | "encrypted" | "secret" | "sensitive" | "system";

export type EnvVar = {
	id: string;
	key: string;
	type: EnvVarType;
	target: string[];
	gitBranch?: string | null;
	comment?: string | null;
	createdAt?: number;
	updatedAt?: number;
	/** UID of the user who most recently edited the env var. Absent if never edited after creation. */
	updatedBy?: string;
	/** UID of the user who created the env var. Present on nearly every env var. */
	createdBy?: string;
	/** Human-readable display name of the user who last edited the env var. Populated even for users no longer on the team — use this for CSV owner names. */
	lastEditedByDisplayName?: string;
	configurationId?: string | null;
};

export type Project = {
	id: string;
	name: string;
	accountId: string;
};

export type TeamMember = {
	uid: string;
	username?: string;
	email?: string;
	name?: string;
};

export type Team = {
	id: string;
	name: string;
	slug: string;
};

export type DeploymentCreator = {
	uid: string;
	username?: string;
	email?: string;
};

export type Deployment = {
	uid: string;
	createdAt: number;
	creator?: DeploymentCreator;
};

type Pagination = { next: number | null; count?: number };

/**
 * Endpoint allowlist. Each entry is a regex matched against the path (no query).
 * Query keys are independently allowlisted. `request()` rejects anything that
 * doesn't match. This is the structural guarantee that replaces the old
 * substring "decrypt=true" check.
 */
const ENDPOINT_ALLOWLIST: ReadonlyArray<{ pathRe: RegExp; allowedQuery: ReadonlySet<string>; family: string }> = [
	{ pathRe: /^\/v2\/teams$/, allowedQuery: new Set(["limit", "until", "since"]), family: "v2/teams" },
	{
		pathRe: /^\/v2\/teams\/[^/]+\/members$/,
		allowedQuery: new Set(["limit", "until", "since", "teamId"]),
		family: "v2/teams/:id/members",
	},
	{ pathRe: /^\/v9\/projects$/, allowedQuery: new Set(["limit", "until", "since", "teamId"]), family: "v9/projects" },
	{
		pathRe: /^\/v9\/projects\/[^/]+\/env$/,
		allowedQuery: new Set(["teamId"]),
		family: "v9/projects/:id/env",
	},
	{
		pathRe: /^\/v6\/deployments$/,
		allowedQuery: new Set(["projectId", "limit", "until", "since", "teamId"]),
		family: "v6/deployments",
	},
];

/**
 * Fields we project out of env var responses. Any other field (including
 * `value` / `decryptedValue` / nested overrides) is dropped on the floor and
 * cannot reach downstream code, logs, or the CSV.
 */
const SAFE_ENV_FIELDS = [
	"id",
	"key",
	"type",
	"target",
	"gitBranch",
	"comment",
	"createdAt",
	"updatedAt",
	"createdBy",
	"updatedBy",
	"lastEditedByDisplayName",
	"configurationId",
] as const satisfies readonly (keyof EnvVar)[];

function projectEnvSafe(raw: unknown): EnvVar {
	const src = (raw ?? {}) as Record<string, unknown>;
	const out: Partial<EnvVar> = {};
	for (const k of SAFE_ENV_FIELDS) {
		if (k in src) (out as Record<string, unknown>)[k] = src[k];
	}
	return out as EnvVar;
}

function classifyPath(path: string): { family: string; allowedQuery: ReadonlySet<string> } | null {
	for (const entry of ENDPOINT_ALLOWLIST) {
		if (entry.pathRe.test(path)) return { family: entry.family, allowedQuery: entry.allowedQuery };
	}
	return null;
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a `Retry-After` header value into a bounded number of seconds.
 * Accepts both the integer-seconds form (`"30"`) and the HTTP-date form
 * (`"Wed, 21 Oct 2026 07:28:00 GMT"`). Clamped to
 * [1, RETRY_AFTER_MAX_SECONDS]; defaults to RETRY_AFTER_DEFAULT_SECONDS
 * on missing/invalid input.
 */
export function parseRetryAfter(raw: string | null | undefined): number {
	if (!raw) return RETRY_AFTER_DEFAULT_SECONDS;
	const trimmed = raw.trim();
	const asNum = Number(trimmed);
	if (Number.isFinite(asNum)) return clampRetrySeconds(asNum);
	const asDate = Date.parse(trimmed);
	if (!Number.isNaN(asDate)) {
		const secs = Math.ceil((asDate - Date.now()) / 1000);
		return clampRetrySeconds(secs);
	}
	return RETRY_AFTER_DEFAULT_SECONDS;
}

function clampRetrySeconds(s: number): number {
	if (!Number.isFinite(s) || s < 1) return 1;
	if (s > RETRY_AFTER_MAX_SECONDS) return RETRY_AFTER_MAX_SECONDS;
	return Math.ceil(s);
}

export type ClientOptions = {
	/** If set, each outgoing request's method and URL (safe — no auth, no secrets) is written to this sink. */
	logRequest?: (line: string) => void;
};

export class VercelClient {
	private teamIdValue: string | null;
	private readonly logRequest: ((line: string) => void) | undefined;

	constructor(private readonly token: string, teamId: string | null = null, opts: ClientOptions = {}) {
		if (!token) throw new Error("VercelClient: token is required");
		this.teamIdValue = teamId && teamId.length > 0 ? teamId : null;
		this.logRequest = opts.logRequest;
	}

	get teamId(): string {
		if (!this.teamIdValue) {
			throw new Error("VercelClient: teamId is required for this call but was not set");
		}
		return this.teamIdValue;
	}

	setTeam(teamId: string): void {
		if (!teamId) throw new Error("VercelClient.setTeam: teamId is required");
		this.teamIdValue = teamId;
	}

	/**
	 * Issue a request. Enforces:
	 *  1. Path matches an allowed endpoint pattern.
	 *  2. No query parameter named (case-insensitively) `decrypt` or `reveal`.
	 *  3. Every query key is in the endpoint's allowlist.
	 * Errors from Vercel surface as status + endpoint family only — never body text.
	 */
	private async request<T>(path: string): Promise<T> {
		const url = new URL(`${API_BASE}${path}`);
		const classified = classifyPath(url.pathname);
		if (!classified) {
			throw new Error(`SAFETY: request path not in allowlist: ${url.pathname}`);
		}
		for (const [key] of url.searchParams) {
			const lower = key.toLowerCase();
			if (lower === "decrypt" || lower === "reveal") {
				throw new Error(`SAFETY: refused request with forbidden query param "${key}"`);
			}
			if (!classified.allowedQuery.has(key)) {
				throw new Error(`SAFETY: query param "${key}" not allowed for ${classified.family}`);
			}
		}

		return this.fetchWithRetry<T>(url, classified.family, /*attempt*/ 0);
	}

	private async fetchWithRetry<T>(url: URL, family: string, attempt: number): Promise<T> {
		// Log the outgoing request (safe to print: URL contains only allowlisted
		// query params, no auth header, no body). Write to the caller-provided
		// sink so stdout stays clean for --out -.
		if (this.logRequest) {
			this.logRequest(`GET ${url.pathname}${url.search}${attempt > 0 ? ` (retry ${attempt})` : ""}`);
		}

		const res = await fetch(url.toString(), {
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/json",
				"User-Agent": "vercel-env-var-exposure-triager/0.1",
			},
		});
		if (!res.ok) {
			if (res.status === 429 && attempt === 0) {
				// Honor Retry-After once; if we're rate-limited again on the retry,
				// surface the 429 so the caller can decide what to do.
				const delayMs = parseRetryAfter(res.headers.get("retry-after")) * 1000;
				if (this.logRequest) {
					this.logRequest(`  [429 received; sleeping ${delayMs}ms then retrying once]`);
				}
				await sleep(delayMs);
				return this.fetchWithRetry<T>(url, family, attempt + 1);
			}
			if (res.status === 429) {
				throw new VercelRequestError(
					res.status,
					family,
					"rate limited (429) after retry; slow down or reduce scope",
				);
			}
			// Deliberately do NOT include response body — prevents accidental secret leaks.
			throw new VercelRequestError(res.status, family, `request failed (status ${res.status})`);
		}
		return (await res.json()) as T;
	}

	private withTeam(path: string): string {
		const sep = path.includes("?") ? "&" : "?";
		return `${path}${sep}teamId=${encodeURIComponent(this.teamId)}`;
	}

	async listAccessibleTeams(): Promise<Team[]> {
		const teams: Team[] = [];
		let until: number | undefined;
		for (;;) {
			const qs = new URLSearchParams({ limit: "100" });
			if (until !== undefined) qs.set("until", String(until));
			const data = await this.request<{ teams: Team[]; pagination?: Pagination }>(
				`/v2/teams?${qs.toString()}`,
			);
			for (const t of data.teams ?? []) {
				teams.push({ id: t.id, name: t.name, slug: t.slug });
			}
			const next = data.pagination?.next;
			if (next == null) break;
			until = next;
			await sleep(RATE_LIMIT_DELAY_MS);
		}
		return teams;
	}

	async listTeamMembers(): Promise<Map<string, TeamMember>> {
		const members = new Map<string, TeamMember>();
		let until: number | undefined;
		for (;;) {
			const qs = new URLSearchParams({ limit: "100" });
			if (until !== undefined) qs.set("until", String(until));
			const path = this.withTeam(`/v2/teams/${encodeURIComponent(this.teamId)}/members?${qs.toString()}`);
			const data = await this.request<{ members: unknown[]; pagination?: Pagination }>(path);
			for (const raw of data.members ?? []) {
				const m = normalizeMember(raw);
				if (m.uid) members.set(m.uid, m);
			}
			const next = data.pagination?.next;
			if (next == null) break;
			until = next;
			await sleep(RATE_LIMIT_DELAY_MS);
		}
		return members;
	}

	async listProjects(): Promise<Project[]> {
		const projects: Project[] = [];
		let until: number | undefined;
		for (;;) {
			const qs = new URLSearchParams({ limit: "100" });
			if (until !== undefined) qs.set("until", String(until));
			const path = this.withTeam(`/v9/projects?${qs.toString()}`);
			const data = await this.request<{ projects: Project[]; pagination?: Pagination }>(path);
			for (const p of data.projects ?? []) {
				projects.push({ id: p.id, name: p.name, accountId: p.accountId });
			}
			const next = data.pagination?.next;
			if (next == null) break;
			until = next;
			await sleep(RATE_LIMIT_DELAY_MS);
		}
		return projects;
	}

	async listProjectEnv(projectId: string): Promise<EnvVar[]> {
		const path = this.withTeam(`/v9/projects/${encodeURIComponent(projectId)}/env`);
		const data = await this.request<{ envs: unknown[] }>(path);
		return (data.envs ?? []).map(projectEnvSafe);
	}

	async listDeployments(projectId: string, sinceMs: number): Promise<Deployment[]> {
		const deployments: Deployment[] = [];
		let until: number | undefined;
		const HARD_CAP = 500;
		for (;;) {
			const qs = new URLSearchParams({
				projectId,
				limit: "100",
				since: String(sinceMs),
			});
			if (until !== undefined) qs.set("until", String(until));
			const path = this.withTeam(`/v6/deployments?${qs.toString()}`);
			const data = await this.request<{ deployments: Deployment[]; pagination?: Pagination }>(path);
			for (const d of data.deployments ?? []) {
				deployments.push({
					uid: d.uid,
					createdAt: d.createdAt,
					creator: d.creator
						? { uid: d.creator.uid, username: d.creator.username, email: d.creator.email }
						: undefined,
				});
			}
			const next = data.pagination?.next;
			if (next == null || deployments.length >= HARD_CAP) break;
			until = next;
			await sleep(RATE_LIMIT_DELAY_MS);
		}
		return deployments;
	}
}

export class VercelRequestError extends Error {
	constructor(public readonly status: number, public readonly endpointFamily: string, message: string) {
		super(`Vercel API ${endpointFamily}: ${message}`);
		this.name = "VercelRequestError";
	}
}

/**
 * Vercel's team-members response has evolved: older shape is flat
 * (`{uid, email, username, name, role}`); newer shape nests profile under
 * `user`. Normalize both into our TeamMember type.
 */
function normalizeMember(raw: unknown): TeamMember {
	const src = (raw ?? {}) as Record<string, unknown>;
	const user = (src["user"] ?? {}) as Record<string, unknown>;
	const pick = <T>(k: string): T | undefined => {
		const fromUser = user[k];
		if (fromUser !== undefined && fromUser !== null && fromUser !== "") return fromUser as T;
		const flat = src[k];
		if (flat !== undefined && flat !== null && flat !== "") return flat as T;
		return undefined;
	};
	return {
		uid: (pick<string>("uid") ?? (src["uid"] as string) ?? "") as string,
		username: pick<string>("username"),
		email: pick<string>("email"),
		name: pick<string>("name"),
	};
}

// Exposed for testing only.
export const __test = { projectEnvSafe, classifyPath, normalizeMember };
