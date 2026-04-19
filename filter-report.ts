import { readFileSync, writeFileSync } from "fs";

const INPUT = "rotation-report.csv";
const OUTPUT = "rotation-report.filtered.csv";

// Non-secret keys in the "Unknown" provider bucket that are safe to drop:
// URLs, config flags, identifiers, Firebase public client config, OAuth client
// IDs, and the non-password parts of a Postgres connection. Ambiguous names
// (webhooks, bearers, edge config, raw "AIRTABLE"/"GITHUB"/"OAI"/"password")
// are intentionally kept for human review.
const DROP_UNKNOWN_KEYS = new Set([
	// Plain URLs
	"AIRTABLE_ENDPOINT_URL",
	"ELASTIC_NODE",
	"EXPRESS_API_URL",
	"FRONTEND_URL",
	"HCB_API_BASE_URL",
	"HCB_BASE_URL",
	"ICAL_URL",
	"OAUTH_AUTHORIZATION_URL",
	"OAUTH_USERINFO_URL",
	"PARCEL_PYXIS_BASE_URL",
	// Config / feature flags / runtime settings
	"AUTH_TRUST_HOST",
	"CACHE_SECONDS",
	"CONTEST",
	"DEVICE_ID_HEADER",
	"ENV",
	"FOR_REALZ",
	"HCB_USE_REAL_MONEY",
	"HEALTH_CHECK_INTERVAL",
	"LOG_LEVEL",
	"METRICS_ENABLED",
	"NAUGHTY",
	"NODE_ENV",
	"NODE_OPTIONS",
	"PORT",
	"PROD",
	"RATE_LIMIT_BURST_LIMIT",
	"RATE_LIMIT_BURST_WINDOW",
	"RATE_LIMIT_DEVICE_RPM",
	"RATE_LIMIT_GLOBAL_RPM",
	"RATE_LIMIT_IP_RPM",
	"STATIC_PREVIEW",
	// Identifiers (not secret)
	"AIRTABLE_BASE",
	"AIRTABLE_BASE_DEPRECATED",
	"AIRTABLE_BASE_ID",
	"AIRTABLE_EMAILS_TABLE",
	"AIRTABLE_GAMES_TABLE",
	"AIRTABLE_PROJECTS_TABLE",
	"AIRTABLE_RSVPS_TABLE",
	"AIRTABLE_TABLE_ID",
	"AIRTABLE_TABLE_NAME",
	"AIRTABLE_VIEW_ID",
	"BAG_APP_ID",
	"BASE_ID",
	"BROWSER_BUDDY_AIRTABLE_ID",
	"HCB_ORG_SLUG",
	"LOOPS_LIST_ID",
	"LOOPS_TRANSACTIONAL_EMAIL_ID",
	"LOOPS_TRANSACTIONAL_TEMPLATE_ID",
	"NEIGHBORHOOD_AIRTABLE_BASE_ID",
	"NEON_PROJECT_ID",
	"POSTAL_LIST_ID",
	// Firebase client config (public by design)
	"apiKey",
	"appId",
	"authDomain",
	"databaseURL",
	"measurementId",
	"messagingSenderId",
	"projectId",
	"storageBucket",
	// OAuth client IDs (public by design)
	"AUTH_SLACK_ID",
	"CLIENT_ID",
	"OAUTH_CLIENT_ID",
	"REACT_APP_CLIENT_ID",
	// Postgres connection parts (without password)
	"PGDATABASE",
	"PGHOST",
	"PGHOST_UNPOOLED",
	"PGPORT",
	"PGUSER",
]);

function parseCsvLine(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				cur += ch;
			}
		} else {
			if (ch === ",") {
				out.push(cur);
				cur = "";
			} else if (ch === '"' && cur === "") {
				inQuotes = true;
			} else {
				cur += ch;
			}
		}
	}
	out.push(cur);
	return out;
}

const raw = readFileSync(INPUT, "utf8");
// Split respecting quoted newlines
const rows: string[] = [];
{
	let buf = "";
	let inQuotes = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === '"') {
			if (inQuotes && raw[i + 1] === '"') {
				buf += '""';
				i++;
				continue;
			}
			inQuotes = !inQuotes;
			buf += ch;
		} else if (ch === "\n" && !inQuotes) {
			if (buf.length) rows.push(buf.replace(/\r$/, ""));
			buf = "";
		} else {
			buf += ch;
		}
	}
	if (buf.length) rows.push(buf.replace(/\r$/, ""));
}

const header = rows[0];
const headerCols = parseCsvLine(header);
const keyIdx = headerCols.indexOf("key");
const providerIdx = headerCols.indexOf("provider");
const recommendationIdx = headerCols.indexOf("recommendation");

const kept: string[] = [header];
const stats = {
	total: 0,
	droppedPublic: 0,
	droppedUnknownNonSecret: 0,
	kept: 0,
};

for (let i = 1; i < rows.length; i++) {
	const cols = parseCsvLine(rows[i]);
	stats.total++;
	const key = cols[keyIdx];
	const provider = cols[providerIdx];
	const rec = cols[recommendationIdx];

	if (rec === "skip-public-client-side") {
		stats.droppedPublic++;
		continue;
	}
	if (provider === "Unknown" && DROP_UNKNOWN_KEYS.has(key)) {
		stats.droppedUnknownNonSecret++;
		continue;
	}
	kept.push(rows[i]);
	stats.kept++;
}

writeFileSync(OUTPUT, kept.join("\n") + "\n");
console.log(stats);
console.log(`Wrote ${OUTPUT} (${kept.length - 1} rows + header)`);
