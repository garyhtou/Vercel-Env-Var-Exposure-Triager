import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "../src/csv.js";

test("toCsv: emits header row and plain fields unquoted, CRLF line endings", () => {
	const csv = toCsv(["a", "b"], [{ a: "one", b: "two" }]);
	assert.equal(csv, "a,b\r\none,two\r\n");
});

test("toCsv: quotes fields containing commas", () => {
	const csv = toCsv(["a"], [{ a: "hello, world" }]);
	assert.ok(csv.includes('"hello, world"'));
});

test("toCsv: escapes embedded double-quotes by doubling", () => {
	const csv = toCsv(["a"], [{ a: 'has "quote"' }]);
	assert.ok(csv.includes('"has ""quote"""'));
});

test("toCsv: quotes fields containing newlines", () => {
	const csv = toCsv(["a"], [{ a: "line\nbreak" }]);
	assert.ok(csv.includes('"line\nbreak"'));
});

test("toCsv: renders null/undefined as empty fields", () => {
	const csv = toCsv(["a", "b", "c"], [{ a: null, b: undefined, c: "x" }]);
	assert.equal(csv, "a,b,c\r\n,,x\r\n");
});

test("toCsv: writes one row per record in header order", () => {
	const csv = toCsv(
		["x", "y"],
		[
			{ x: 1, y: 2 },
			{ y: 4, x: 3 },
		],
	);
	assert.equal(csv, "x,y\r\n1,2\r\n3,4\r\n");
});

test("toCsv: emits header-only output for empty rows", () => {
	assert.equal(toCsv(["a", "b"], []), "a,b\r\n");
});

test("toCsv: quotes CRLF as well as LF", () => {
	const csv = toCsv(["a"], [{ a: "a\r\nb" }]);
	assert.ok(csv.includes('"a\r\nb"'));
});

// Formula-injection neutralization (OWASP). Each trigger char becomes "'<char>..."
// so spreadsheets render the field as plain text rather than evaluating it.
for (const trigger of ["=", "+", "-", "@", "\t"]) {
	test(`toCsv: neutralizes leading formula trigger "${trigger === "\t" ? "\\t" : trigger}"`, () => {
		const csv = toCsv(["a"], [{ a: `${trigger}HYPERLINK("http://evil/",1)` }]);
		const body = csv.split("\r\n")[1] ?? "";
		// Value is wrapped in quotes (because of the = or leading special) and prefixed with '.
		assert.ok(body.startsWith(`"'${trigger}`), `body starts with quote + apostrophe + trigger; got: ${body}`);
	});
}

test("toCsv: leading = with internal comma still neutralized", () => {
	const csv = toCsv(["a"], [{ a: "=SUM(A1,B1)" }]);
	assert.ok(csv.includes(`"'=SUM(A1,B1)"`));
});

test("toCsv: non-trigger-leading strings are unchanged", () => {
	const csv = toCsv(["a"], [{ a: "plain text" }]);
	assert.ok(csv.includes("plain text\r\n"));
	assert.ok(!csv.includes("'plain"));
});

test("toCsv: leading CR is also neutralized (prevents carriage control injection)", () => {
	const csv = toCsv(["a"], [{ a: "\rbad" }]);
	const body = csv.split("\r\n")[1] ?? "";
	assert.ok(body.startsWith(`"'\r`));
});

test("toCsv: empty string is unchanged (no neutralization, no quoting)", () => {
	const csv = toCsv(["a"], [{ a: "" }]);
	assert.equal(csv, "a\r\n\r\n");
});

test("toCsv: trailing = is NOT neutralized (only leading triggers matter)", () => {
	const csv = toCsv(["a"], [{ a: "x=y" }]);
	assert.equal(csv, "a\r\nx=y\r\n");
});

test("toCsv: middle comma still triggers quoting when combined with leading trigger", () => {
	const csv = toCsv(["a"], [{ a: "=A1,B1" }]);
	assert.ok(csv.includes(`"'=A1,B1"`));
});

test("toCsv: numeric 0 is rendered as '0', not empty", () => {
	const csv = toCsv(["a"], [{ a: 0 }]);
	assert.equal(csv, "a\r\n0\r\n");
});

test("toCsv: boolean false is rendered as 'false', not empty", () => {
	const csv = toCsv(["a"], [{ a: false }]);
	assert.equal(csv, "a\r\nfalse\r\n");
});

test("toCsv: missing key in a row renders as empty field", () => {
	const csv = toCsv(["a", "b"], [{ a: "x" } as Record<string, unknown>]);
	assert.equal(csv, "a,b\r\nx,\r\n");
});

test("toCsv: double-encoded formula payload (\"==FOO\") is neutralized on leading = only", () => {
	const csv = toCsv(["a"], [{ a: "==HYPERLINK(\"x\")" }]);
	const body = csv.split("\r\n")[1] ?? "";
	// Must start with '="=...' — the leading = is neutralized with a single apostrophe.
	assert.ok(body.startsWith(`"'==`), `got: ${body}`);
});

test("toCsv: classic =cmd formula-injection variant is neutralized", () => {
	const csv = toCsv(["a"], [{ a: "=cmd|' /c calc'!A1" }]);
	// No comma/quote/newline in this value, so no CSV quoting — just the apostrophe prefix.
	const body = csv.split("\r\n")[1] ?? "";
	assert.equal(body, "'=cmd|' /c calc'!A1");
});

// Prior security review flagged: neutralization checks only str[0], so a
// leading whitespace char (including Unicode NBSP/ZWSP/BOM) would bypass.
// Excel and Sheets trim leading whitespace on import, then evaluate the
// formula. Every one of these must be caught.
for (const prefix of [
	[" ", "ASCII space"],
	["\u00a0", "NBSP U+00A0"],
	["\u200b", "ZWSP U+200B"],
	["\uFEFF", "BOM U+FEFF"],
	["\u200c", "ZWNJ U+200C"],
	["  \t ", "mixed leading whitespace"],
] as const) {
	test(`toCsv: neutralizes leading ${prefix[1]} before =`, () => {
		const payload = `${prefix[0]}=HYPERLINK("http://evil/",1)`;
		const csv = toCsv(["a"], [{ a: payload }]);
		const body = csv.split("\r\n")[1] ?? "";
		// Apostrophe must be prepended; the leading whitespace is preserved verbatim
		// (renders harmlessly) but the trigger char is disarmed.
		assert.ok(body.startsWith(`"'${prefix[0]}=`), `got: ${body}`);
	});
}

test("toCsv: purely whitespace (no formula trigger) is left alone", () => {
	const csv = toCsv(["a"], [{ a: "   hello" }]);
	assert.equal(csv, "a\r\n   hello\r\n");
});
