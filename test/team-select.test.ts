import { test } from "node:test";
import assert from "node:assert/strict";
import { selectTeams } from "../src/team-select.js";
import type { Team } from "../src/vercel.js";

const alpha: Team = { id: "team_a", name: "Alpha", slug: "alpha" };
const bravo: Team = { id: "team_b", name: "Bravo", slug: "bravo" };
const charlie: Team = { id: "team_c", name: "Charlie", slug: "charlie" };

test("selectTeams: auto-picks the only accessible team", async () => {
	const result = await selectTeams([alpha], {});
	assert.equal(result.mode, "single");
	assert.deepEqual(result.teams, [alpha]);
});

test("selectTeams: --team <id> matches by id", async () => {
	const result = await selectTeams([alpha, bravo], { explicitTeam: "team_b" });
	assert.deepEqual(result.teams, [bravo]);
	assert.equal(result.mode, "single");
});

test("selectTeams: --team <slug> matches by slug", async () => {
	const result = await selectTeams([alpha, bravo], { explicitTeam: "bravo" });
	assert.deepEqual(result.teams, [bravo]);
});

test("selectTeams: --team with no match throws with accessible list", async () => {
	await assert.rejects(
		() => selectTeams([alpha, bravo], { explicitTeam: "team_x" }),
		/not found among accessible teams.*team_a.*team_b/s,
	);
});

test("selectTeams: --all-teams returns every team in 'all' mode", async () => {
	const result = await selectTeams([alpha, bravo, charlie], { allTeams: true });
	assert.equal(result.mode, "all");
	assert.deepEqual(result.teams, [alpha, bravo, charlie]);
});

test("selectTeams: --all-teams with one accessible team still auto-picks silently", async () => {
	// The single-team shortcut fires before --all-teams; this keeps the
	// behavior consistent whether the user passed --all-teams or not.
	const result = await selectTeams([alpha], { allTeams: true });
	assert.equal(result.mode, "single");
	assert.deepEqual(result.teams, [alpha]);
});

test("selectTeams: errors when zero teams are accessible", async () => {
	await assert.rejects(() => selectTeams([], {}), /No teams accessible/);
});

test("selectTeams: errors when multiple teams and stdin is not a TTY", async () => {
	await assert.rejects(
		() =>
			selectTeams([alpha, bravo], {
				promptStream: { tty: false },
			}),
		/stdin is not a TTY.*--team.*--all-teams/s,
	);
});

test("selectTeams: --team takes precedence over --all-teams", async () => {
	const result = await selectTeams([alpha, bravo], {
		explicitTeam: "alpha",
		allTeams: true,
	});
	assert.equal(result.mode, "single");
	assert.deepEqual(result.teams, [alpha]);
});

test("selectTeams: --team error lists ALL accessible teams so user can correct", async () => {
	let err: Error | null = null;
	try {
		await selectTeams([alpha, bravo, charlie], { explicitTeam: "missing" });
	} catch (e) {
		err = e as Error;
	}
	assert.ok(err);
	// All three teams must appear in the error message.
	assert.match(err!.message, /alpha/);
	assert.match(err!.message, /bravo/);
	assert.match(err!.message, /charlie/);
});

test("selectTeams: --team match is exact (case-sensitive)", async () => {
	// Slug comparison must not silently match variant-case to avoid surprise.
	await assert.rejects(
		() => selectTeams([alpha], { explicitTeam: "ALPHA" }),
		/not found among accessible/,
	);
});

test("selectTeams: single-team shortcut fires even when explicitTeam is a non-match", async () => {
	// Actually — the single-team shortcut should NOT fire when --team is given
	// and doesn't match. User expectation is "if I named a team, use that or fail".
	await assert.rejects(
		() => selectTeams([alpha], { explicitTeam: "nonexistent" }),
		/not found/,
		"explicit --team must be authoritative even with one accessible team",
	);
});
