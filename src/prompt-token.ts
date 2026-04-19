import { readFileSync } from "node:fs";

/**
 * Read a Vercel token interactively from a TTY with echo suppressed.
 *
 * Uses stdin raw mode and manually handles Enter / Backspace / Ctrl-C so
 * nothing is written to the terminal. The prompt text goes to stderr so it
 * doesn't contaminate stdout redirects. The returned string is trimmed.
 *
 * Preconditions:
 *  - `stdin.isTTY` must be true. Callers should check before invoking.
 */
export async function promptTokenHidden(
	prompt: string,
	io: { stdin: NodeJS.ReadStream; stderr: NodeJS.WriteStream } = {
		stdin: process.stdin,
		stderr: process.stderr,
	},
): Promise<string> {
	if (!io.stdin.isTTY) {
		throw new Error("promptTokenHidden: stdin is not a TTY");
	}

	return new Promise<string>((resolve, reject) => {
		io.stderr.write(prompt);
		const stdin = io.stdin;
		const wasRaw = stdin.isRaw;
		stdin.setRawMode(true);
		stdin.resume();
		// Avoid default utf8 decoding so multi-byte keystrokes are handled byte-safely.
		stdin.setEncoding("utf8");

		let buf = "";
		const cleanup = (): void => {
			stdin.removeListener("data", onData);
			stdin.setRawMode(wasRaw);
			stdin.pause();
		};

		const onData = (chunk: string): void => {
			for (const ch of chunk) {
				const code = ch.charCodeAt(0);
				if (code === 3) {
					// Ctrl-C
					cleanup();
					io.stderr.write("\n");
					reject(new Error("Token entry cancelled"));
					return;
				}
				if (code === 13 || code === 10) {
					// Enter
					cleanup();
					io.stderr.write("\n");
					resolve(buf.trim());
					return;
				}
				if (code === 127 || code === 8) {
					// Backspace / Delete — silently drop last char, no visible update.
					if (buf.length > 0) buf = buf.slice(0, -1);
					continue;
				}
				// Ignore other control characters; accept printable input.
				if (code < 32) continue;
				buf += ch;
			}
		};

		stdin.on("data", onData);
	});
}

/**
 * Read a token non-interactively from a file path. The literal `-` is treated
 * as "read all of stdin" so callers can pipe: `cat vtoken | tool --token-file -`.
 */
export function readTokenFromFile(path: string): string {
	if (path === "-") {
		// Read entire stdin synchronously.
		const data = readFileSync(0, "utf8");
		return data.trim();
	}
	return readFileSync(path, "utf8").trim();
}

export type TokenSource =
	| { kind: "file"; path: string }
	| { kind: "env" }
	| { kind: "flag" }
	| { kind: "prompt" };

export type ResolveTokenInputs = {
	tokenFile?: string;
	tokenFlag?: string;
	envToken?: string;
	isTty: boolean;
};

export type ResolveTokenDeps = {
	readFile: (path: string) => string;
	prompt: () => Promise<string>;
	warn: (msg: string) => void;
};

export type ResolveTokenResult = { token: string; source: TokenSource };

/**
 * Pure token-acquisition policy, decoupled from the real CLI so every branch
 * can be unit-tested. Precedence: file → env → flag (warns) → prompt (TTY only).
 * Throws on any unrecoverable error with a single-sentence message; the CLI
 * is responsible for converting throws into exit codes.
 */
export async function resolveToken(
	inputs: ResolveTokenInputs,
	deps: ResolveTokenDeps,
): Promise<ResolveTokenResult> {
	let raw: string | undefined;
	let source: TokenSource | undefined;

	if (inputs.tokenFile) {
		raw = deps.readFile(inputs.tokenFile);
		source = { kind: "file", path: inputs.tokenFile };
	} else if (inputs.envToken && inputs.envToken.trim() !== "") {
		raw = inputs.envToken.trim();
		source = { kind: "env" };
	} else if (inputs.tokenFlag && inputs.tokenFlag.trim() !== "") {
		deps.warn(
			"--token passes the token on argv (visible via `ps`). Prefer --token-file or VERCEL_TOKEN.",
		);
		raw = inputs.tokenFlag.trim();
		source = { kind: "flag" };
	} else if (inputs.isTty) {
		raw = await deps.prompt();
		source = { kind: "prompt" };
	} else {
		throw new Error(
			"No token source and stdin is not a TTY. Provide one of: --token-file <path>, VERCEL_TOKEN env var, --token <t>, or run in an interactive terminal.",
		);
	}

	if (!raw || raw.length === 0) {
		throw new Error(`No token read from ${describeSource(source)}.`);
	}
	if (/\s/.test(raw) || /^bearer\s/i.test(raw)) {
		throw new Error('Token looks malformed (whitespace or "Bearer " prefix). Pass the raw token.');
	}
	return { token: raw, source };
}

export function describeSource(source: TokenSource | undefined): string {
	if (!source) return "<unknown>";
	switch (source.kind) {
		case "file":
			return source.path === "-" ? "--token-file (stdin)" : `--token-file ${source.path}`;
		case "env":
			return "$VERCEL_TOKEN";
		case "flag":
			return "--token";
		case "prompt":
			return "interactive prompt";
	}
}
