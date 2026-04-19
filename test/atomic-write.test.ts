import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "../src/atomic-write.js";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "atomic-write-test-"));
}

test("atomicWriteFile: writes content to a fresh path", () => {
	const dir = tmp();
	try {
		const p = join(dir, "out.csv");
		atomicWriteFile(p, "hello");
		assert.equal(readFileSync(p, "utf8"), "hello");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("atomicWriteFile: overwrites an existing regular file", () => {
	const dir = tmp();
	try {
		const p = join(dir, "out.csv");
		writeFileSync(p, "old");
		atomicWriteFile(p, "new");
		assert.equal(readFileSync(p, "utf8"), "new");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("atomicWriteFile: refuses to follow a symlink at the target (TOCTOU protection)", () => {
	const dir = tmp();
	try {
		const victim = join(dir, "victim.txt");
		const target = join(dir, "out.csv");
		writeFileSync(victim, "untouched");
		symlinkSync(victim, target);
		assert.throws(() => atomicWriteFile(target, "PAYLOAD"), /symlink/);
		// Victim file unchanged.
		assert.equal(readFileSync(victim, "utf8"), "untouched");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("atomicWriteFile: writes with mode 0o600", () => {
	const dir = tmp();
	try {
		const p = join(dir, "out.csv");
		atomicWriteFile(p, "hello");
		const st = statSync(p);
		// Mask off file-type bits; check only permission bits.
		assert.equal(st.mode & 0o777, 0o600);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("atomicWriteFile: leaves no stray temp files behind on success", () => {
	const dir = tmp();
	try {
		const p = join(dir, "out.csv");
		atomicWriteFile(p, "hello");
		const files = readdirSync(dir);
		// Only the target file should remain.
		assert.deepEqual(files, ["out.csv"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("atomicWriteFile: refuses to write when resolved directory is world-writable without sticky bit", () => {
	const parent = tmp();
	try {
		const unsafeDir = join(parent, "shared");
		mkdirSync(unsafeDir, { mode: 0o777 });
		// Explicitly strip the sticky bit to simulate an unsafe shared dir.
		chmodSync(unsafeDir, 0o777);
		const target = join(unsafeDir, "out.csv");
		assert.throws(() => atomicWriteFile(target, "PAYLOAD"), /world-writable/);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("atomicWriteFile: follows OS-canonical symlinks (e.g., user-owned symlinks to user-owned dirs)", () => {
	// User-owned parent symlinking to a user-owned dir is fine — this is how
	// macOS's /tmp → /private/tmp and common workspace symlinks work. The defense
	// against parent-swap attacks is the ownership/permission check on the
	// resolved directory, not a blanket "no symlinks" rule.
	const parent = tmp();
	try {
		const realDir = join(parent, "real");
		const linkDir = join(parent, "link");
		mkdirSync(realDir);
		symlinkSync(realDir, linkDir);
		const target = join(linkDir, "out.csv");
		atomicWriteFile(target, "ok");
		// Write lands in the resolved directory.
		assert.equal(readFileSync(join(realDir, "out.csv"), "utf8"), "ok");
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("atomicWriteFile: allows writes when there are no symlinks anywhere in the path", () => {
	const dir = tmp();
	try {
		const sub = join(dir, "sub");
		mkdirSync(sub);
		const p = join(sub, "out.csv");
		atomicWriteFile(p, "ok");
		assert.equal(readFileSync(p, "utf8"), "ok");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
