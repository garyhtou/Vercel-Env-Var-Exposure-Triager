const NEEDS_QUOTE = /[",\r\n]/;
// Leading characters that Excel / Google Sheets interpret as a formula or
// system call. OWASP-recommended neutralization: prepend a single quote so
// the spreadsheet renders the value as text.
const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r"]);
// Leading whitespace-like chars Excel / Sheets strip on import. We trim
// these BEFORE the trigger check so a payload like "  =CMD" or "\u00a0=CMD"
// can't slip past. Importantly this set does NOT include \t or \r — those
// are themselves FORMULA_TRIGGERS and must reach the check.
const LEADING_TRIMMABLE = /^[ \u00a0\u200b\u200c\u200d\ufeff]+/;

function neutralizeFormula(str: string): string {
	if (str.length === 0) return str;
	const afterLeadingWs = str.replace(LEADING_TRIMMABLE, "");
	const first = afterLeadingWs[0];
	if (first && FORMULA_TRIGGERS.has(first)) return `'${str}`;
	return str;
}

function escapeField(value: unknown): string {
	if (value === null || value === undefined) return "";
	const str = neutralizeFormula(String(value));
	if (!NEEDS_QUOTE.test(str)) return str;
	return `"${str.replace(/"/g, '""')}"`;
}

export function toCsv(headers: readonly string[], rows: readonly Record<string, unknown>[]): string {
	// CRLF line endings for maximum spreadsheet compatibility (Excel on Windows).
	const EOL = "\r\n";
	const lines: string[] = [headers.map(escapeField).join(",")];
	for (const row of rows) {
		lines.push(headers.map((h) => escapeField(row[h])).join(","));
	}
	return lines.join(EOL) + EOL;
}
