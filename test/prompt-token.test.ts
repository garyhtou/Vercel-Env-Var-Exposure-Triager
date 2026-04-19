import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSource, readTokenFromFile, resolveToken } from "../src/prompt-token.js";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "tok-test-"));
}

// ---------- readTokenFromFile ----------

test("readTokenFromFile: reads and trims file contents", () => {
	const dir = tmp();
	try {
		const p = join(dir, "t");
		writeFileSync(p, "  xyz123\n\n");
		assert.equal(readTokenFromFile(p), "xyz123");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readTokenFromFile: preserves internal content (only trims ends)", () => {
	const dir = tmp();
	try {
		const p = join(dir, "t");
		writeFileSync(p, "abc-def_ghi\n");
		assert.equal(readTokenFromFile(p), "abc-def_ghi");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readTokenFromFile: throws with clear path on nonexistent file", () => {
	assert.throws(() => readTokenFromFile("/nonexistent/path/for/token/test"));
});

// ---------- describeSource ----------

test("describeSource: file path is echoed", () => {
	assert.equal(describeSource({ kind: "file", path: "/tmp/t" }), "--token-file /tmp/t");
});

test("describeSource: stdin marker is clear", () => {
	assert.equal(describeSource({ kind: "file", path: "-" }), "--token-file (stdin)");
});

test("describeSource: labels env / flag / prompt", () => {
	assert.equal(describeSource({ kind: "env" }), "$VERCEL_TOKEN");
	assert.equal(describeSource({ kind: "flag" }), "--token");
	assert.equal(describeSource({ kind: "prompt" }), "interactive prompt");
});

// ---------- resolveToken precedence ----------

function stubDeps(overrides: Partial<Parameters<typeof resolveToken>[1]> = {}) {
	const warnings: string[] = [];
	return {
		deps: {
			readFile: overrides.readFile ?? ((p: string) => `file-${p}`),
			prompt: overrides.prompt ?? (async () => "prompt-token"),
			warn: overrides.warn ?? ((m: string) => warnings.push(m)),
		},
		warnings,
	};
}

test("resolveToken: --token-file beats env, flag, and prompt", async () => {
	const { deps } = stubDeps({ readFile: () => "from-file" });
	const r = await resolveToken(
		{ tokenFile: "/p", tokenFlag: "ignored", envToken: "ignored-env", isTty: true },
		deps,
	);
	assert.equal(r.token, "from-file");
	assert.deepEqual(r.source, { kind: "file", path: "/p" });
});

test("resolveToken: env beats flag and prompt when no --token-file", async () => {
	const { deps } = stubDeps();
	const r = await resolveToken({ tokenFlag: "ignored", envToken: "  envtok  ", isTty: true }, deps);
	assert.equal(r.token, "envtok");
	assert.equal(r.source.kind, "env");
});

test("resolveToken: --token used when no file/env, with warning", async () => {
	const { deps, warnings } = stubDeps();
	const r = await resolveToken({ tokenFlag: "flagtok", envToken: undefined, isTty: true }, deps);
	assert.equal(r.token, "flagtok");
	assert.equal(r.source.kind, "flag");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /argv.*ps/);
});

test("resolveToken: prompts when no source and TTY", async () => {
	const { deps } = stubDeps({ prompt: async () => "typed-secret" });
	const r = await resolveToken({ isTty: true }, deps);
	assert.equal(r.token, "typed-secret");
	assert.equal(r.source.kind, "prompt");
});

test("resolveToken: errors when no source and not a TTY", async () => {
	const { deps } = stubDeps();
	await assert.rejects(() => resolveToken({ isTty: false }, deps), /No token source.*not a TTY/);
});

test("resolveToken: empty env is treated as absent", async () => {
	// Env var set to "" or whitespace only should not count.
	const { deps } = stubDeps({ prompt: async () => "typed" });
	const r = await resolveToken({ envToken: "   ", isTty: true }, deps);
	assert.equal(r.source.kind, "prompt");
});

test("resolveToken: empty flag is treated as absent", async () => {
	const { deps } = stubDeps({ prompt: async () => "typed" });
	const r = await resolveToken({ tokenFlag: "", isTty: true }, deps);
	assert.equal(r.source.kind, "prompt");
});

test("resolveToken: rejects malformed token (whitespace inside)", async () => {
	const { deps } = stubDeps({ readFile: () => "tok with space" });
	await assert.rejects(
		() => resolveToken({ tokenFile: "/p", isTty: false }, deps),
		/malformed.*whitespace/,
	);
});

test('resolveToken: rejects "Bearer " prefix to prevent double-prefixing', async () => {
	const { deps } = stubDeps({ readFile: () => "Bearer abc123" });
	await assert.rejects(
		() => resolveToken({ tokenFile: "/p", isTty: false }, deps),
		/Bearer.*prefix/,
	);
});

test("resolveToken: rejects lowercase bearer prefix too", async () => {
	const { deps } = stubDeps({ readFile: () => "bearer abc" });
	await assert.rejects(() => resolveToken({ tokenFile: "/p", isTty: false }, deps), /Bearer.*prefix/);
});

test("resolveToken: rejects empty file contents", async () => {
	const { deps } = stubDeps({ readFile: () => "" });
	await assert.rejects(() => resolveToken({ tokenFile: "/p", isTty: false }, deps), /No token read/);
});

test("resolveToken: file-read error propagates", async () => {
	const { deps } = stubDeps({
		readFile: () => {
			throw new Error("ENOENT: no such file");
		},
	});
	await assert.rejects(() => resolveToken({ tokenFile: "/missing", isTty: false }, deps), /ENOENT/);
});

test("resolveToken: prompt that returns empty string fails loudly", async () => {
	const { deps } = stubDeps({ prompt: async () => "" });
	await assert.rejects(() => resolveToken({ isTty: true }, deps), /No token read from interactive prompt/);
});

test("resolveToken: warn is only called once for --token path", async () => {
	const { deps, warnings } = stubDeps();
	await resolveToken({ tokenFlag: "t", isTty: true }, deps);
	assert.equal(warnings.length, 1);
});

test("resolveToken: warn is NOT called for --token-file or env", async () => {
	const { deps, warnings } = stubDeps({ readFile: () => "x" });
	await resolveToken({ tokenFile: "/p", isTty: true }, deps);
	await resolveToken({ envToken: "x", isTty: true }, deps);
	assert.deepEqual(warnings, []);
});

test("resolveToken: prompt returning whitespace-token is rejected as malformed", async () => {
	const { deps } = stubDeps({ prompt: async () => "tok with space" });
	await assert.rejects(() => resolveToken({ isTty: true }, deps), /malformed/);
});

test('resolveToken: env value "Bearer xxx" is rejected', async () => {
	const { deps } = stubDeps();
	await assert.rejects(
		() => resolveToken({ envToken: "Bearer xyz", isTty: false }, deps),
		/Bearer.*prefix/,
	);
});

test("resolveToken: prompt is only called when other sources are absent", async () => {
	let promptCalls = 0;
	const { deps } = stubDeps({
		prompt: async () => {
			promptCalls += 1;
			return "should-not-be-used";
		},
		readFile: () => "from-file",
	});
	await resolveToken({ tokenFile: "/p", isTty: true }, deps);
	assert.equal(promptCalls, 0, "prompt must not be called when --token-file supplies a token");
});

test("resolveToken: --token-file '-' is passed through to the readFile callback", async () => {
	let seen: string | undefined;
	const { deps } = stubDeps({
		readFile: (p: string) => {
			seen = p;
			return "stdin-token";
		},
	});
	const r = await resolveToken({ tokenFile: "-", isTty: false }, deps);
	assert.equal(seen, "-", "readFile must receive the dash so it can route to stdin");
	assert.equal(r.token, "stdin-token");
	assert.equal(describeSource(r.source), "--token-file (stdin)");
});

test("resolveToken: file read that returns only a newline is treated as empty", async () => {
	const { deps } = stubDeps({ readFile: () => "" });
	// (readTokenFromFile trims real files — we simulate the post-trim result here.)
	await assert.rejects(() => resolveToken({ tokenFile: "/p", isTty: false }, deps), /No token read/);
});
