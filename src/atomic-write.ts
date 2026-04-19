import { lstatSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, basename, resolve as resolvePath } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Write `data` to `targetPath` atomically:
 *  1. Refuse to follow an existing symlink at the target (prevents leaf-symlink TOCTOU).
 *  2. Resolve the parent directory through realpath; refuse if that resolved
 *     directory is world-writable without the sticky bit (the classic shared-tmp
 *     parent-swap scenario) or is owned by a different user.
 *  3. Write to a sibling temp file under the realpath'd directory, mode 0o600, O_EXCL.
 *  4. Rename into place — rename is atomic on POSIX.
 *
 * Note: we allow OS-canonical symlinks like macOS's /tmp → /private/tmp;
 * what we reject is a resolved directory that isn't safely user-owned.
 */
export function atomicWriteFile(targetPath: string, data: string | Uint8Array): void {
	// Reject existing symlink at the target leaf.
	try {
		const st = lstatSync(targetPath);
		if (st.isSymbolicLink()) {
			throw new Error(`Refusing to write to ${targetPath}: path is a symlink. Remove it or choose a different --out.`);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}

	const lexicalDir = resolvePath(dirname(targetPath));
	let realDir: string;
	try {
		realDir = realpathSync(lexicalDir);
	} catch (err) {
		throw new Error(
			`Refusing to write: cannot resolve output directory ${lexicalDir}: ${(err as Error).message}`,
		);
	}

	// Ownership / permission check on the RESOLVED directory — this is where
	// the file will actually land. Catches the shared-tmp parent-swap attack
	// without false-positiving on OS-canonical symlinks like /tmp → /private/tmp.
	let dirStat;
	try {
		dirStat = statSync(realDir);
	} catch (err) {
		throw new Error(`Refusing to write: cannot stat resolved directory ${realDir}: ${(err as Error).message}`);
	}
	const myUid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (myUid !== undefined && dirStat.uid !== myUid && dirStat.uid !== 0) {
		throw new Error(
			`Refusing to write to ${targetPath}: resolved directory ${realDir} is owned by uid ${dirStat.uid} (current user ${myUid}). Pass an --out under your own home/workspace.`,
		);
	}
	const mode = dirStat.mode;
	const worldWritable = (mode & 0o002) !== 0;
	const sticky = (mode & 0o1000) !== 0;
	if (worldWritable && !sticky) {
		throw new Error(
			`Refusing to write to ${targetPath}: resolved directory ${realDir} is world-writable without the sticky bit. Pass an --out under a private directory.`,
		);
	}

	const base = basename(targetPath);
	const tmp = join(realDir, `.${base}.${randomBytes(8).toString("hex")}.tmp`);

	writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
	try {
		renameSync(tmp, targetPath);
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		throw err;
	}
}
