import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ENTRY = join(process.cwd(), "src/index.ts");

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
	const res = spawnSync("npx", ["tsx", ENTRY, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env, FORCE_COLOR: "0" },
		timeout: 20_000,
	});
	return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("CLI: --help exits 0 and describes all flags", { timeout: 25_000 }, () => {
	const { status, stdout } = runCli(["--help"]);
	assert.equal(status, 0);
	for (const flag of [
		"--team",
		"--all-teams",
		"--project",
		"--token-file",
		"--token ",
		"--out",
		"--lookback-days",
		"--include-vercel-prefixed",
		"--log-requests",
		"--dry-run",
	]) {
		assert.ok(stdout.includes(flag), `help should mention ${flag}`);
	}
});

test(
	"CLI: no token + no TTY exits 1 with clear message (non-interactive path)",
	{ timeout: 25_000 },
	() => {
		// Pipe empty stdin (not a TTY) and clear VERCEL_TOKEN; no flags supply a token.
		const res = spawnSync("npx", ["tsx", ENTRY], {
			encoding: "utf8",
			input: "",
			env: {
				...process.env,
				VERCEL_TOKEN: "",
				FORCE_COLOR: "0",
			},
			timeout: 20_000,
		});
		assert.equal(res.status, 1);
		assert.match(res.stderr, /No token source|Missing token/);
	},
);

test(
	"CLI: malformed token (has whitespace) via env exits 1 with clear message",
	{ timeout: 25_000 },
	() => {
		const res = spawnSync("npx", ["tsx", ENTRY], {
			encoding: "utf8",
			input: "",
			env: {
				...process.env,
				VERCEL_TOKEN: "tok with space",
				FORCE_COLOR: "0",
			},
			timeout: 20_000,
		});
		assert.equal(res.status, 1);
		assert.match(res.stderr, /malformed/);
	},
);

test(
	'CLI: "Bearer ..." token via env exits 1 with clear message',
	{ timeout: 25_000 },
	() => {
		const res = spawnSync("npx", ["tsx", ENTRY], {
			encoding: "utf8",
			input: "",
			env: {
				...process.env,
				VERCEL_TOKEN: "Bearer abc123",
				FORCE_COLOR: "0",
			},
			timeout: 20_000,
		});
		assert.equal(res.status, 1);
		assert.match(res.stderr, /Bearer.*prefix/);
	},
);

test(
	"CLI: invalid --lookback-days exits 1",
	{ timeout: 25_000 },
	() => {
		const res = runCli(["--lookback-days", "0"], { VERCEL_TOKEN: "x".repeat(20) });
		assert.equal(res.status, 1);
		assert.match(res.stderr, /lookback-days/);
	},
);

test(
	"CLI: bad token produces a preflight-style friendly error",
	{ timeout: 30_000 },
	() => {
		// Clearly-invalid token (no whitespace, no 'Bearer ' so it passes shape check).
		// The Vercel API will reject with 401. We expect the preflight guidance.
		const res = runCli([], { VERCEL_TOKEN: "definitely-not-a-real-token-abc123xyz789" });
		assert.equal(res.status, 1);
		// Must include actionable guidance rather than a raw API error dump.
		assert.match(res.stderr, /Token rejected by Vercel|status 401|status 403/);
	},
);
