import { test } from "node:test";
import assert from "node:assert/strict";
import { VercelClient, VercelRequestError, __test, parseRetryAfter } from "../src/vercel.js";

class ProbeClient extends VercelClient {
	async probe(path: string): Promise<unknown> {
		// @ts-expect-error — exercising private request() in tests
		return this.request(path);
	}
}

test("constructor: requires a non-empty token", () => {
	assert.throws(() => new VercelClient(""), /token is required/);
});

test("constructor: allows construction without a teamId", () => {
	const client = new VercelClient("t");
	assert.ok(client);
});

test("teamId getter: throws if used before being set", () => {
	const client = new VercelClient("t");
	assert.throws(() => client.teamId, /teamId is required/);
});

test("setTeam: assigns the team and makes teamId readable", () => {
	const client = new VercelClient("t");
	client.setTeam("team_abc");
	assert.equal(client.teamId, "team_abc");
});

test("setTeam: rejects empty string", () => {
	const client = new VercelClient("t");
	assert.throws(() => client.setTeam(""), /teamId is required/);
});

// ---- decrypt / reveal guard ----

test("request: rejects decrypt=true (legacy phrasing)", async () => {
	const client = new ProbeClient("t", "team_x");
	await assert.rejects(
		() => client.probe("/v9/projects/foo/env?decrypt=true&teamId=x"),
		/forbidden query param "decrypt"/,
	);
});

test("request: rejects case-variant DECRYPT=True", async () => {
	const client = new ProbeClient("t", "team_x");
	await assert.rejects(() => client.probe("/v9/projects/foo/env?DECRYPT=True"), /forbidden query param/);
});

test("request: rejects decrypt with any value (decrypt=2, decrypt=yes)", async () => {
	const client = new ProbeClient("t", "team_x");
	await assert.rejects(() => client.probe("/v9/projects/foo/env?decrypt=2"), /forbidden query param/);
	await assert.rejects(() => client.probe("/v9/projects/foo/env?decrypt=yes"), /forbidden query param/);
});

test("request: rejects reveal param too", async () => {
	const client = new ProbeClient("t", "team_x");
	await assert.rejects(() => client.probe("/v9/projects/foo/env?reveal=1"), /forbidden query param "reveal"/);
});

test("request: rejects paths outside the endpoint allowlist", async () => {
	const client = new ProbeClient("t", "team_x");
	await assert.rejects(
		() => client.probe("/v9/projects/foo/env/envId"),
		/path not in allowlist/,
		"single-env endpoint must be rejected — that's the one that can return values",
	);
	await assert.rejects(() => client.probe("/v1/user"), /path not in allowlist/);
	await assert.rejects(() => client.probe("/v9/projects/foo/env/envId?foo=bar"), /path not in allowlist/);
});

test("request: rejects unknown query params on an allowed path", async () => {
	const client = new ProbeClient("t", "team_x");
	await assert.rejects(
		() => client.probe("/v9/projects/foo/env?teamId=x&weirdParam=1"),
		/not allowed for v9\/projects\/:id\/env/,
	);
});

test("request: guard fires without any network I/O for forbidden paths", async () => {
	const original = globalThis.fetch;
	let called = 0;
	globalThis.fetch = (async () => {
		called += 1;
		return new Response("{}", { status: 200 });
	}) as typeof fetch;
	try {
		const client = new ProbeClient("t", "team_x");
		await assert.rejects(() => client.probe("/v9/projects/foo/env?decrypt=true"));
		await assert.rejects(() => client.probe("/v9/projects/foo/env/ID"));
		assert.equal(called, 0, "fetch must not be invoked when guard trips");
	} finally {
		globalThis.fetch = original;
	}
});

// ---- env var projection ----

test("projectEnvSafe: allowlist drops value and decryptedValue", () => {
	const out = __test.projectEnvSafe({
		id: "e1",
		key: "K",
		type: "plain",
		target: ["production"],
		value: "LEAK",
		decryptedValue: "LEAK",
	});
	assert.equal((out as Record<string, unknown>)["value"], undefined);
	assert.equal((out as Record<string, unknown>)["decryptedValue"], undefined);
	assert.equal(out.key, "K");
});

test("projectEnvSafe: allowlist drops unknown nested fields that could carry values", () => {
	const out = __test.projectEnvSafe({
		id: "e1",
		key: "K",
		type: "plain",
		target: ["production"],
		overrides: [{ value: "SEKRET" }],
		contentHint: { value: "SEKRET" },
		customEnvironmentOverrides: { production: { value: "SEKRET" } },
	});
	assert.equal((out as Record<string, unknown>)["overrides"], undefined);
	assert.equal((out as Record<string, unknown>)["contentHint"], undefined);
	assert.equal((out as Record<string, unknown>)["customEnvironmentOverrides"], undefined);
});

test("projectEnvSafe: preserves the configurationId field so integration-backed envs can be flagged", () => {
	const out = __test.projectEnvSafe({ id: "e", key: "K", type: "encrypted", target: ["production"], configurationId: "cfg_1" });
	assert.equal(out.configurationId, "cfg_1");
});

// ---- team member shape compat ----

test("normalizeMember: reads flat {uid,email,username,name}", () => {
	const m = __test.normalizeMember({ uid: "u1", email: "a@x", username: "alice", name: "Alice" });
	assert.deepEqual(m, { uid: "u1", email: "a@x", username: "alice", name: "Alice" });
});

test("normalizeMember: reads nested {user:{email,username,name}}", () => {
	const m = __test.normalizeMember({ uid: "u1", user: { email: "a@x", username: "alice", name: "Alice" } });
	assert.equal(m.email, "a@x");
	assert.equal(m.username, "alice");
	assert.equal(m.name, "Alice");
});

test("normalizeMember: nested overrides flat when flat is empty", () => {
	const m = __test.normalizeMember({ uid: "u1", email: "", user: { email: "real@x" } });
	assert.equal(m.email, "real@x");
});

test("normalizeMember: uid falls back to flat when only flat is set", () => {
	const m = __test.normalizeMember({ uid: "u_only_flat" });
	assert.equal(m.uid, "u_only_flat");
});

// ---- end-to-end ingress ----

test("listProjectEnv: projects responses through the allowlist", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				envs: [
					{ id: "e1", key: "A", type: "plain", target: ["production"], value: "LEAK_A", decryptedValue: "LEAK_A" },
					{
						id: "e2",
						key: "B",
						type: "encrypted",
						target: ["production"],
						value: "LEAK_B",
						overrides: [{ value: "LEAK_NESTED" }],
					},
				],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		)) as typeof fetch;
	try {
		const client = new VercelClient("t", "team_x");
		const envs = await client.listProjectEnv("prj_1");
		assert.equal(envs.length, 2);
		for (const env of envs) {
			const flat = env as Record<string, unknown>;
			assert.equal(flat["value"], undefined);
			assert.equal(flat["decryptedValue"], undefined);
			assert.equal(flat["overrides"], undefined);
		}
		assert.equal(envs[0]?.key, "A");
	} finally {
		globalThis.fetch = original;
	}
});

// ---- error surface ----

test("request: 429 surfaces a status-only VercelRequestError with no body text", async () => {
	const original = globalThis.fetch;
	// Respond 429 with a short retry-after so the test retries quickly,
	// then fails with a clean 429 (no body text in the message).
	globalThis.fetch = (async () =>
		new Response("secret-looking-body-content", {
			status: 429,
			headers: { "retry-after": "1" },
		})) as typeof fetch;
	try {
		const client = new ProbeClient("t", "team_x");
		let caught: Error | null = null;
		try {
			await client.probe("/v9/projects?teamId=x");
		} catch (err) {
			caught = err as Error;
		}
		assert.ok(caught instanceof VercelRequestError);
		assert.equal((caught as VercelRequestError).status, 429);
		assert.ok(!caught!.message.includes("secret-looking-body-content"));
	} finally {
		globalThis.fetch = original;
	}
});

test("request: 5xx error message never embeds the response body", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response("postgres://user:PASS@db/", { status: 500 })) as typeof fetch;
	try {
		const client = new ProbeClient("t", "team_x");
		let caught: Error | null = null;
		try {
			await client.probe("/v9/projects?teamId=x");
		} catch (err) {
			caught = err as Error;
		}
		assert.ok(caught);
		assert.ok(!caught!.message.includes("postgres://"), "body must never be embedded in error message");
		assert.ok(!caught!.message.includes("PASS"), "body must never be embedded in error message");
	} finally {
		globalThis.fetch = original;
	}
});

// ---- request logging ----

test("logRequest: called once per outgoing request with safe method+path+query", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ teams: [] }), { status: 200 })) as typeof fetch;
	const lines: string[] = [];
	try {
		const client = new VercelClient("t", null, { logRequest: (l) => lines.push(l) });
		await client.listAccessibleTeams();
		assert.equal(lines.length, 1);
		assert.ok(lines[0]?.startsWith("GET /v2/teams"), `got: ${lines[0]}`);
		// Token must NEVER appear.
		assert.ok(!lines[0]?.includes("Bearer"));
		assert.ok(!lines[0]?.includes(" t "));
	} finally {
		globalThis.fetch = original;
	}
});

test("logRequest: not invoked when no sink is provided", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ teams: [] }), { status: 200 })) as typeof fetch;
	try {
		const client = new VercelClient("t");
		await client.listAccessibleTeams(); // should not throw from undefined sink
	} finally {
		globalThis.fetch = original;
	}
});

// ---- pagination edge cases ----

test("listAccessibleTeams: paginates across multiple pages", async () => {
	const original = globalThis.fetch;
	let call = 0;
	globalThis.fetch = (async () => {
		call += 1;
		if (call === 1) {
			return new Response(
				JSON.stringify({
					teams: [{ id: "t1", name: "T1", slug: "t1" }],
					pagination: { next: 100 },
				}),
				{ status: 200 },
			);
		}
		return new Response(
			JSON.stringify({ teams: [{ id: "t2", name: "T2", slug: "t2" }], pagination: { next: null } }),
			{ status: 200 },
		);
	}) as typeof fetch;
	try {
		const client = new VercelClient("t");
		const teams = await client.listAccessibleTeams();
		assert.equal(teams.length, 2);
		assert.equal(call, 2);
	} finally {
		globalThis.fetch = original;
	}
});

test("listProjects: empty result returns an empty array (no crash)", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ projects: [] }), { status: 200 })) as typeof fetch;
	try {
		const client = new VercelClient("t", "team_x");
		const projects = await client.listProjects();
		assert.deepEqual(projects, []);
	} finally {
		globalThis.fetch = original;
	}
});

test("listProjectEnv: empty envs returns empty array", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ envs: [] }), { status: 200 })) as typeof fetch;
	try {
		const client = new VercelClient("t", "team_x");
		assert.deepEqual(await client.listProjectEnv("prj"), []);
	} finally {
		globalThis.fetch = original;
	}
});

test("listDeployments: HARD_CAP bounds memory usage on pathological upstream", async () => {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls += 1;
		// Always return 100 deployments + a "next" cursor — simulate a runaway upstream.
		const deployments = Array.from({ length: 100 }, (_, i) => ({
			uid: `d_${calls}_${i}`,
			createdAt: calls * 1000 + i,
			creator: { uid: "u1", username: "alice" },
		}));
		return new Response(
			JSON.stringify({ deployments, pagination: { next: calls * 1000 } }),
			{ status: 200 },
		);
	}) as typeof fetch;
	try {
		const client = new VercelClient("t", "team_x");
		const deployments = await client.listDeployments("prj", 0);
		// HARD_CAP is 500 in the implementation; after the cap trips, loop exits.
		assert.ok(deployments.length <= 500, `expected <= 500, got ${deployments.length}`);
		assert.ok(deployments.length >= 500, `expected >= 500 so cap actually trips`);
		assert.ok(calls >= 5, `expected >= 5 fetches, got ${calls}`);
	} finally {
		globalThis.fetch = original;
	}
});

test("listTeamMembers: end-to-end passes nested .user shape through normalizeMember", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				members: [
					{ uid: "u1", user: { name: "Alice", email: "a@x", username: "alice" } },
					{ uid: "u2", email: "b@x" }, // flat fallback
				],
			}),
			{ status: 200 },
		)) as typeof fetch;
	try {
		const client = new VercelClient("t", "team_x");
		const members = await client.listTeamMembers();
		assert.equal(members.size, 2);
		assert.equal(members.get("u1")?.name, "Alice");
		assert.equal(members.get("u2")?.email, "b@x");
	} finally {
		globalThis.fetch = original;
	}
});

test("request: rejects URLs containing URL-encoded 'decrypt' via URL parsing", async () => {
	const original = globalThis.fetch;
	let called = 0;
	globalThis.fetch = (async () => {
		called += 1;
		return new Response("{}", { status: 200 });
	}) as typeof fetch;
	try {
		const client = new ProbeClient("t", "team_x");
		// URL class decodes query param keys — %64ecrypt is a case variant encoding of 'decrypt'.
		await assert.rejects(
			() => client.probe("/v9/projects/foo/env?%64ecrypt=true"),
			/forbidden query param/,
		);
		assert.equal(called, 0);
	} finally {
		globalThis.fetch = original;
	}
});

test("request: rejects path-segment routing attempts to single-env endpoint", async () => {
	const client = new ProbeClient("t", "team_x");
	// The single-env endpoint is the one that CAN return values; must be blocked.
	await assert.rejects(
		() => client.probe("/v9/projects/foo/env/env_id_xyz"),
		/path not in allowlist/,
	);
});

test("request: endpoint allowlist rejects completely unrelated v1 user endpoints", async () => {
	const client = new ProbeClient("t", "team_x");
	await assert.rejects(() => client.probe("/v1/user"), /path not in allowlist/);
	await assert.rejects(() => client.probe("/v2/user"), /path not in allowlist/);
});

// ---- Retry-After handling ----

test("parseRetryAfter: integer-seconds form", () => {
	assert.equal(parseRetryAfter("10"), 10);
	assert.equal(parseRetryAfter("  30  "), 30);
});

test("parseRetryAfter: clamps to max (60s)", () => {
	assert.equal(parseRetryAfter("600"), 60);
});

test("parseRetryAfter: clamps negative / zero to 1s", () => {
	assert.equal(parseRetryAfter("0"), 1);
	assert.equal(parseRetryAfter("-5"), 1);
});

test("parseRetryAfter: HTTP-date form is parsed to a relative second count", () => {
	const future = new Date(Date.now() + 7_000).toUTCString();
	const s = parseRetryAfter(future);
	// Allow for small clock skew during test execution.
	assert.ok(s >= 1 && s <= 10, `expected ~7s, got ${s}`);
});

test("parseRetryAfter: missing / garbage returns default (5s)", () => {
	assert.equal(parseRetryAfter(null), 5);
	assert.equal(parseRetryAfter(undefined), 5);
	assert.equal(parseRetryAfter(""), 5);
	assert.equal(parseRetryAfter("not-a-duration"), 5);
});

test("request: honors Retry-After and retries once before giving up", async () => {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls += 1;
		if (calls === 1) {
			// Use "1" second so the test doesn't actually wait 5s.
			return new Response("", { status: 429, headers: { "retry-after": "1" } });
		}
		return new Response(JSON.stringify({ projects: [] }), { status: 200 });
	}) as typeof fetch;
	try {
		const client = new VercelClient("t", "team_x");
		const projects = await client.listProjects();
		assert.deepEqual(projects, []);
		assert.equal(calls, 2, "should have retried exactly once");
	} finally {
		globalThis.fetch = original;
	}
});

test("request: throws with clear message if still 429 after retry", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response("", { status: 429, headers: { "retry-after": "1" } })) as typeof fetch;
	try {
		const client = new VercelClient("t", "team_x");
		await assert.rejects(() => client.listProjects(), /rate limited.*after retry/);
	} finally {
		globalThis.fetch = original;
	}
});

test("VercelRequestError: exposes status and endpointFamily on the error instance", async () => {
	const original = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response("x", { status: 403 })) as typeof fetch;
	try {
		const client = new ProbeClient("t", "team_x");
		let caught: unknown;
		try {
			await client.probe("/v9/projects?teamId=x");
		} catch (err) {
			caught = err;
		}
		assert.ok(caught instanceof VercelRequestError);
		assert.equal((caught as VercelRequestError).status, 403);
		assert.equal((caught as VercelRequestError).endpointFamily, "v9/projects");
	} finally {
		globalThis.fetch = original;
	}
});
