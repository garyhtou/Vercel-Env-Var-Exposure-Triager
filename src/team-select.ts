import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { Team } from "./vercel.js";

export type Selection = { teams: Team[]; mode: "single" | "all" };

/**
 * Resolve which team(s) to scan given the token's accessible teams and CLI flags.
 *
 * Preference order:
 *   1. Explicit --team <id> → look up in the list; error if not found.
 *   2. Only one team accessible → pick silently.
 *   3. --all-teams flag → scan every accessible team.
 *   4. Otherwise: prompt the user interactively (fails if stdin is not a TTY).
 */
export async function selectTeams(
	accessible: readonly Team[],
	opts: { explicitTeam?: string; allTeams?: boolean; promptStream?: { tty: boolean } },
): Promise<Selection> {
	if (accessible.length === 0) {
		throw new Error(
			"No teams accessible with this token. If this token is scoped to a personal account, this tool does not support that (teams only).",
		);
	}

	if (opts.explicitTeam) {
		const match = accessible.find(
			(t) => t.id === opts.explicitTeam || t.slug === opts.explicitTeam,
		);
		if (!match) {
			const available = accessible.map((t) => `${t.id} (${t.slug})`).join(", ");
			throw new Error(
				`--team "${opts.explicitTeam}" not found among accessible teams: ${available}`,
			);
		}
		return { teams: [match], mode: "single" };
	}

	if (accessible.length === 1) {
		const only = accessible[0];
		if (!only) throw new Error("Unreachable: empty after length check");
		return { teams: [only], mode: "single" };
	}

	if (opts.allTeams) {
		return { teams: [...accessible], mode: "all" };
	}

	return promptForSelection(accessible, opts.promptStream);
}

async function promptForSelection(
	teams: readonly Team[],
	promptStream?: { tty: boolean },
): Promise<Selection> {
	const isTty = promptStream?.tty ?? stdin.isTTY;
	if (!isTty) {
		const list = teams.map((t) => `  - ${t.slug} (${t.id})`).join("\n");
		throw new Error(
			`Multiple teams accessible and stdin is not a TTY; cannot prompt. Re-run with --team <idOrSlug> or --all-teams.\nAvailable:\n${list}`,
		);
	}

	stdout.write("\nMultiple teams accessible with this token:\n");
	teams.forEach((t, i) => {
		stdout.write(`  ${i + 1}. ${t.name} (${t.slug}) — ${t.id}\n`);
	});
	stdout.write(`  ${teams.length + 1}. ALL teams\n`);

	const rl = readline.createInterface({ input: stdin, output: stdout });
	try {
		const answer = (await rl.question(`Choose [1-${teams.length + 1}]: `)).trim();
		const n = Number.parseInt(answer, 10);
		if (!Number.isInteger(n) || n < 1 || n > teams.length + 1) {
			throw new Error(`Invalid selection "${answer}"; expected 1-${teams.length + 1}.`);
		}
		if (n === teams.length + 1) return { teams: [...teams], mode: "all" };
		const picked = teams[n - 1];
		if (!picked) throw new Error("Unreachable: index bounds checked");
		return { teams: [picked], mode: "single" };
	} finally {
		rl.close();
	}
}
