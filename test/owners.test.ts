import { test } from "node:test";
import assert from "node:assert/strict";
import { pickBackupOwner, rankDeployers, resolveOwner } from "../src/owners.js";
import type { Deployment, TeamMember } from "../src/vercel.js";

function members(entries: Array<[string, Partial<TeamMember>]>): Map<string, TeamMember> {
	const m = new Map<string, TeamMember>();
	for (const [uid, partial] of entries) m.set(uid, { uid, ...partial });
	return m;
}

function deploy(uid: string, username: string, createdAt: number): Deployment {
	return { uid: `d_${createdAt}`, createdAt, creator: { uid, username } };
}

test("resolveOwner: resolves a known UID to name + email", () => {
	const m = members([["u1", { name: "Alice", email: "a@x" }]]);
	assert.deepEqual(resolveOwner("u1", m), { uid: "u1", name: "Alice", email: "a@x" });
});

test("resolveOwner: falls back to username if name is missing", () => {
	const m = members([["u1", { username: "alice" }]]);
	const o = resolveOwner("u1", m);
	assert.equal(o.name, "alice");
	assert.equal(o.email, "");
});

test("resolveOwner: falls back to raw UID when the member is unknown", () => {
	const o = resolveOwner("ghost", members([]));
	assert.deepEqual(o, { uid: "ghost", name: "ghost", email: "" });
});

test("resolveOwner: returns empty owner when uid is undefined", () => {
	const o = resolveOwner(undefined, members([]));
	assert.deepEqual(o, { uid: "", name: "", email: "" });
});

test("rankDeployers: ranks by deploy count desc", () => {
	const ranked = rankDeployers([
		deploy("u1", "alice", 1),
		deploy("u2", "bob", 2),
		deploy("u2", "bob", 3),
	]);
	assert.deepEqual(ranked, ["u2", "u1"]);
});

test("rankDeployers: ties break by most recent deployment", () => {
	const ranked = rankDeployers([
		deploy("u1", "alice", 10),
		deploy("u2", "bob", 20),
	]);
	assert.deepEqual(ranked, ["u2", "u1"]);
});

test("rankDeployers: filters known bot usernames", () => {
	const ranked = rankDeployers([
		deploy("u1", "alice", 1),
		deploy("u_gh", "github-actions[bot]", 2),
		deploy("u_vc", "vercel", 3),
		deploy("u_vcb", "vercel-bot", 4),
		deploy("u_dep", "dependabot[bot]", 5),
	]);
	assert.deepEqual(ranked, ["u1"]);
});

test("rankDeployers: treats any username containing [bot] as a bot", () => {
	const ranked = rankDeployers([
		deploy("u1", "alice", 1),
		deploy("u_x", "somecustom[bot]", 2),
	]);
	assert.deepEqual(ranked, ["u1"]);
});

test("rankDeployers: skips creators with missing username", () => {
	const ranked = rankDeployers([
		deploy("u1", "alice", 1),
		{ uid: "d_anon", createdAt: 2, creator: { uid: "u_anon", username: "" } },
		{ uid: "d_none", createdAt: 3 },
	]);
	assert.deepEqual(ranked, ["u1"]);
});

test("rankDeployers: returns empty array when no human deployers", () => {
	assert.deepEqual(rankDeployers([]), []);
	const ranked = rankDeployers([deploy("u_vc", "vercel", 1)]);
	assert.deepEqual(ranked, []);
});

test("pickBackupOwner: skips the primary and picks the next ranked", () => {
	const m = members([
		["u1", { name: "Alice", email: "a@x" }],
		["u2", { name: "Bob", email: "b@x" }],
	]);
	const backup = pickBackupOwner(["u2", "u1"], "u2", m);
	assert.equal(backup?.uid, "u1");
	assert.equal(backup?.name, "Alice");
});

test("pickBackupOwner: returns null when primary is the only deployer", () => {
	const m = members([["u2", { name: "Bob" }]]);
	assert.equal(pickBackupOwner(["u2"], "u2", m), null);
});

test("pickBackupOwner: returns null when no deployers at all", () => {
	assert.equal(pickBackupOwner([], "u2", members([])), null);
});

test("pickBackupOwner: when primary is undefined, returns top ranked", () => {
	const m = members([["u2", { name: "Bob" }]]);
	const backup = pickBackupOwner(["u2", "u1"], undefined, m);
	assert.equal(backup?.uid, "u2");
});

test("pickBackupOwner: backup resolves via members map (falls back to uid if missing)", () => {
	const backup = pickBackupOwner(["ghost", "u1"], "u1", members([]));
	assert.equal(backup?.uid, "ghost");
	assert.equal(backup?.name, "ghost");
});

test("rankDeployers: single deployer with one deploy still ranks", () => {
	const ranked = rankDeployers([deploy("u1", "alice", 1)]);
	assert.deepEqual(ranked, ["u1"]);
});

test("rankDeployers: renovate[bot] is filtered", () => {
	const ranked = rankDeployers([
		deploy("u1", "alice", 1),
		deploy("u_r", "renovate[bot]", 2),
	]);
	assert.deepEqual(ranked, ["u1"]);
});

test("rankDeployers: creator with undefined uid is skipped", () => {
	const ranked = rankDeployers([
		deploy("u1", "alice", 1),
		// @ts-expect-error — deliberately malformed to test robustness
		{ uid: "d_x", createdAt: 2, creator: { username: "bob" } },
	]);
	assert.deepEqual(ranked, ["u1"]);
});

test("resolveOwner: a member with only uid renders uid as name", () => {
	const m = members([["u1", {}]]);
	const o = resolveOwner("u1", m);
	assert.equal(o.name, "u1");
});

test("pickBackupOwner: empty deployer ranks list returns null", () => {
	const m = members([["u2", { name: "Bob" }]]);
	assert.equal(pickBackupOwner([], "u1", m), null);
});

test("pickBackupOwner: deployer ranks with empty-string UIDs are skipped", () => {
	const m = members([["u2", { name: "Bob" }]]);
	const backup = pickBackupOwner(["", "u2"], "u1", m);
	assert.equal(backup?.uid, "u2");
});
