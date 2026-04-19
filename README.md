# Vercel Env Var Exposure Triager

Audit tool for the [Vercel April 2026 security incident](https://vercel.com/kb/bulletin/vercel-april-2026-security-incident).
Produces a CSV worklist of **every non-`sensitive` environment variable in a Vercel team** so they can be rotated.

**It does not read secret values.** The Vercel API is only called without the
`decrypt` flag, and `value`/`decryptedValue` are stripped from every response on
ingress as defense in depth.

---

## Motivation

I work at [Hack Club](https://hackclub.com), and our Vercel team has 400+ projects and 750+ environment variables. Manually triaging a leak at that scale — figuring out which variables are actually secrets, which were already public, who owns what, and what can safely be skipped — would have eaten a week.

So I built this tool with the help of Claude Code. It turns the incident-response question from *"where do I even start?"* into a sortable, owner-attributed CSV that a team can divide and conquer in an afternoon. Hopefully it helps you too.

---

## Quick start

```sh
npm install
npx tsx src/index.ts
```

That's it. The tool will prompt for your Vercel token (input hidden), auto-detect your team, and write `rotation-report.csv` in the current directory. Open the CSV in a spreadsheet and start delegating rotations.

Need a token? Create one at [vercel.com/account/tokens](https://vercel.com/account/tokens) — pick your team as the scope and a short expiration (1 day is fine). **Revoke it when you're done.**

> Want to automate it, pin a team, or pipe the token from a secrets manager? See [Options](#options) and [Passing the token](#passing-the-token) below.

---

## Options

| Flag                          | Default                 | Description                                                      |
| ----------------------------- | ----------------------- | ---------------------------------------------------------------- |
| `--team <idOrSlug>`           | auto-detect             | Vercel team ID or slug; omit to auto-pick / prompt               |
| `--all-teams`                 | off                     | Scan every team the token can access (combined CSV output)       |
| `--project <idOrName>`        | off                     | Limit to one or more projects (repeat flag for multiple)         |
| `--token-file <path>`         | —                       | Read token from a file; `-` reads from stdin                     |
| `--token <t>`                 | —                       | Vercel API token (DISCOURAGED: visible to `ps`; prints a warning) |
| `$VERCEL_TOKEN` env var       | —                       | Token via environment variable                                   |
| (no flag, TTY)                | —                       | Interactive hidden-input prompt (default when no source is set)  |
| `--out <path>`                | `rotation-report.csv`   | Output CSV path                                                  |
| `--lookback-days <n>`         | `90`                    | Deployment history window for backup-owner signal                |
| `--include-vercel-prefixed`   | off                     | Include env vars starting with `VERCEL_` (default: skip)         |
| `--log-requests`              | off                     | Print every API request (method + path + query) to stderr        |
| `--dry-run`                   | off                     | List teams + projects that would be scanned, then exit           |

**Exit codes**: `0` = clean, `1` = fatal error (no CSV), `2` = CSV written but some projects failed (see `<out>.scan-errors.txt`).

### Team selection behaviour

- `--team <idOrSlug>` — use this team; error if the token can't access it.
- No flag, **1 team** accessible → use it silently.
- No flag, **2+ teams** accessible → interactive prompt (stdin must be a TTY; otherwise error asking for `--team` or `--all-teams`).
- `--all-teams` → scan every accessible team; CSV rows include `team_name` + `team_slug` columns.

To look up a team ID manually: [vercel.com/dashboard](https://vercel.com/dashboard) → switch to the team → **Settings** → **General**. Or via API with the token set: `curl -H "Authorization: Bearer $VERCEL_TOKEN" https://api.vercel.com/v2/teams | jq '.teams[] | {id, name, slug}'`.

---

## Passing the token

The tool picks the first available in this order: `--token-file` → `$VERCEL_TOKEN` → `--token` → interactive prompt.

```sh
# 1. Interactive prompt (default — no flags needed; requires a TTY).
#    Keystrokes are not echoed.
npx tsx src/index.ts

# 2. File, 0600, never hits argv or history. Best for scripts.
echo "xxxxxxxxxxxxxxxxxxxx" > /tmp/vtoken && chmod 600 /tmp/vtoken
npx tsx src/index.ts --token-file /tmp/vtoken

# 3. Pipe from stdin (great with a secret manager).
vault kv get -field=token secret/vercel | npx tsx src/index.ts --token-file -

# 4. Environment variable (fine for local dev).
export VERCEL_TOKEN=xxxxxxxxxxxxxxxxxxxx
npx tsx src/index.ts

# 5. Discouraged: --token <t> is visible in `ps auxww` and shell history.
#    The tool prints a warning when used.
npx tsx src/index.ts --token xxxxxxxxxxxxxxxxxxxx
```

When the tool starts it prints `Token source: <source>` to stderr so you can see which path was taken.

### Token creation tips

- **Scope**: pick the **team** you want to audit (not "Full Account") unless you need `--all-teams`.
- **Role**: your role must be high enough to read env var metadata and project deployments (Developer or above).
- **Expiration**: short (e.g., 1 day). Short-lived tokens limit blast radius.
- **Audit-log hygiene**: do NOT use a token you are about to rotate — create a fresh one for the scan, then revoke it when finished.

---

## Cleanup

- **Revoke the token** at [vercel.com/account/tokens](https://vercel.com/account/tokens) as soon as you're done.
- The generated CSV maps every secret *name* to a project and owner — treat it as internal. It contains no values.

---

## Security of this tool

This tool operates on sensitive data (secret *names* and *owners*, though never values). Design decisions that keep it safe:

### Never reads secret values

Two layered guarantees:

1. **Endpoint + query allowlist** (`src/vercel.ts`). Every outgoing request has its URL parsed, and the pathname is matched against a small explicit allowlist of endpoints (`/v2/teams`, `/v2/teams/:id/members`, `/v9/projects`, `/v9/projects/:id/env` (list only), `/v6/deployments`). Each endpoint has its own allowed query-parameter set. Any `decrypt` or `reveal` param (regardless of case or value) is rejected *before* `fetch` is called. Any unknown path, including the single-env endpoint `/v9/projects/:id/env/:envId` (which is the one that *can* return values), is refused.
2. **Allowlist projection on ingress**. The client picks a fixed set of safe fields (`id`, `key`, `type`, `target`, `gitBranch`, `comment`, `createdAt`, `updatedAt`, `createdBy`, `lastUpdatedBy`, `configurationId`) out of every env object. Anything else — `value`, `decryptedValue`, nested `overrides`, `contentHint`, future field names — is dropped on the floor and never reaches CSV rows, logs, or error messages.

If Vercel's API ever changes to return values by default, or to accept a new "reveal" parameter, the tool fails closed: the unknown path/param is rejected, and even if it slipped through, the projection would strip any value-bearing fields.

### Read-only

- The tool only issues `GET` requests. No `PATCH`, `POST`, or `DELETE` calls exist in the code. The actual rotation step is deliberately out of scope (see the "After rotation" section) so a bug in this tool cannot mass-mutate your environment.

### Minimal data egress

- **Response bodies are never echoed in errors.** A Vercel error surfaces as `Vercel API <endpoint-family>: request failed (status N)` — no body snippet. A 200-char slice of a misrouted response body could contain a short API key; truncation isn't safe enough, so nothing is logged.
- The output CSV contains only: team + project name/id, env var name + type + targets, inferred provider, owner names + emails, timestamps, deploy count, and a dashboard deep-link. No `value`, no `comment` (dropped at the CSV layer as of the security review), no deployment URLs, no build artifacts.
- **CSV formula injection is neutralized.** Any field starting with `= + - @ \t \r` is prefixed with a single quote so Excel/Sheets render it as plain text rather than evaluating it as a formula. Team/project/env-var names cannot be weaponized into spreadsheet payloads.
- **Token handling**: `--token-file` (recommended) or `$VERCEL_TOKEN` (fine). `--token <t>` works but prints a warning because it exposes the token to `ps`. The token is validated for shape (no whitespace, no `Bearer ` prefix) so an error message can't accidentally echo a mis-pasted value.
- **CSV is written atomically**: to a sibling `.tmp` file with mode `0o600` and `O_EXCL`, then renamed into place. If the target is a symlink, the tool refuses to write (TOCTOU protection).

### Transparent API access

Use `--log-requests` to print every API request (method + path + query) to stderr as it happens. Because the endpoint/query allowlist guarantees URLs contain no secret data, this is safe to enable from an auditability standpoint.

Caveat: these lines include **team IDs** (`teamId=team_xxx`) and **project IDs** (`projectId=prj_xxx`). Those are internal identifiers, not secrets, but on public CI logs you may want to redact them. `--log-requests` is aimed at paranoid local audits, not public output.

### Supply-chain posture

The tool's own source code in `src/` uses only Node built-ins (`fetch`, `fs`, `crypto`, `readline/promises`). There are **no runtime `dependencies`** in `package.json`.

That said, `npm start` / `npx tsx src/index.ts` loads `tsx` and `esbuild` in-process to transpile TypeScript on the fly. A compromise of those packages would have the same privileges as this tool. Mitigations:

- `package-lock.json` is committed with SHA512 integrity hashes.
- Use `npm ci` (not `npm install`) to refuse any install that doesn't match the lockfile.
- If maximum paranoia is required, compile ahead of time (`npx tsc --outDir dist --module NodeNext`) and run `node dist/index.js` to skip loading `tsx`/`esbuild` at runtime.

### Audit-log hygiene

The token you use for this audit will itself appear in Vercel's activity log. When investigating *which* of your existing tokens may have been used by the attacker during the incident window, **do not use a token you are about to rotate** — create a fresh short-lived token for the audit, then revoke it as soon as the scan finishes.

### No network dependencies beyond Vercel

- Runtime uses Node's built-in `fetch` and `fs`. Dev-deps (`tsx`, `typescript`, `@types/node`) are only used for running/typechecking and never ship a request.

### Partial-failure resilience

- Errors on **one project** don't kill the whole run. The failing project is recorded in a sidecar `<out>.scan-errors.txt` with the stage (`env` / `deployments` / `members`), and the scan continues.
- Errors on **listing team members** degrade to UID-only owner columns for that team (common with scope-limited OAuth tokens) rather than skipping the team entirely.
- Errors on **listing projects** abort that one team; other teams continue.
- Exit code is **`2`** when any per-project or per-team error occurred — CI can tell "worklist generated but partial" apart from "all clean".
- 429 surfaces an explicit rate-limit message rather than silent retries. If you hit 429 frequently, reduce `--all-teams` scope or widen `--lookback-days` to reduce deploy-endpoint churn.

**Important for CI**: if the scan-errors sidecar exists, treat the CSV as incomplete. Rows for failed teams/projects are missing, not zeroed. `rotation-report.csv.scan-errors.txt` is your canonical list of what *didn't* get scanned.

---

## Design and scope decisions

### Rotation scope: why these `type`s?

| Vercel env var `type` | Included in CSV? | Rationale                                                        |
| --------------------- | ---------------- | ---------------------------------------------------------------- |
| `sensitive`           | no               | Write-only per Vercel; [Vercel's incident guidance](https://vercel.com/kb/bulletin/vercel-april-2026-security-incident) says these remain safe. |
| `system`              | no               | Vercel-managed (`VERCEL_URL`, etc.), not user-controlled.         |
| `plain`               | yes              | Readable in the Vercel UI — definitely exposed.                   |
| `encrypted`           | yes              | Legacy default; readable via API by admins — treat as exposed.    |
| `secret`              | yes              | Legacy Vercel Secrets (deprecated); included for completeness.    |

`VERCEL_*`-prefixed user-defined keys are skipped by default (`--include-vercel-prefixed` opts in). These are almost always either system vars or Vercel-provided integration tokens that need a different rotation path.

### `NEXT_PUBLIC_` / `VITE_` / `PUBLIC_`

These get grouped under provider `Public (client-side)` but are **not** silently dropped, because:

1. People sometimes put real secrets behind a `PUBLIC_` prefix by accident.
2. Some "public" API keys (Stripe publishable, Mapbox, Google Maps) are only safe if origin/domain restrictions are configured — rotation is worthwhile if those restrictions weren't set.

Reviewers can filter them out in the spreadsheet if the usage is known-safe.

### Owner assignment

- **Primary owner** = the `lastUpdatedBy` UID on each env var, resolved against the team member list. This is the person who most recently touched the variable — usually close to the right person, occasionally whoever onboarded it.
- **Backup owner** = the most frequent human deployer of that project in the last 90 days (configurable via `--lookback-days`), excluding the primary. Bot creators (`vercel`, `vercel-bot`, anything containing `[bot]`) are filtered out. Rationale: deploy history is the freshest per-project activity signal we can cheaply derive from Vercel without crawling git history.
- Deliberately **not** used:
  - Project creator — Vercel's project object doesn't reliably expose a creator UID, and for long-lived projects the creator is often gone.
  - Git commit authors — would require cloning or GitHub API access, out of scope for a read-only Vercel tool.

### Provider inference

`src/providers.ts` uses an ordered list of prefix/substring rules (first match wins). It's a heuristic — extend the list for your organization's naming conventions. Unmatched keys fall through to `Unknown-secret` (if the name contains `SECRET`/`TOKEN`/`KEY`/`PASS`/`CREDENTIAL`) or `Unknown`.

### Team-level scope

The tool scans a single team per run. Multi-team audits are deliberately separate invocations so each run has a clear scope and its own time-scoped token.

### What this tool does **not** do

- **Rotate** secrets — vendor-side rotation is out of scope; this tool only produces the worklist.
- **Audit logs** — checking Vercel activity logs for anomalous env var reads is a parallel, manual task.
- **Revoke the malicious OAuth app** at Google Workspace — that's done in Google Admin, not here.
- **Patch** env vars to `type: sensitive` after rotation — deliberately manual, see below.

---

---

## CSV schema

```
team_name, team_slug,
project_name, project_id,
env_id, configuration_id,
key, type, targets, git_branch,
provider, recommendation,
primary_owner_name, primary_owner_email,
backup_owner_name, backup_owner_email, backup_deploy_count_90d,
last_updated_at, last_updated_days_ago, created_at,
vercel_url
```

Rows are sorted by `provider`, then `team_slug`, then `project_name`, then `key`.

### Column notes

- **`env_id`** — the Vercel env var ID. Needed by any external workflow that wants to `PATCH /v9/projects/{project_id}/env/{env_id}?teamId={team_slug-or-id}` after the vendor-side rotation. This tool does **not** perform any `PATCH` — rotation is explicitly out of scope.
- **`configuration_id`** — populated when the env var is managed by a Vercel marketplace integration (Neon, Supabase, Stripe, etc.). When present, `recommendation` will be `review-integration-managed`; use this ID to identify which integration to chase in Vercel's dashboard.
- **`recommendation`** — one of:
  - `rotate` — a recognized-provider secret; rotate at the vendor, update the value in Vercel, and flip `type` to `sensitive`.
  - `skip-public-client-side` — `NEXT_PUBLIC_` / `VITE_` / `PUBLIC_`; almost always safe to skip (shipped to browsers by design). Double-check for misuse.
  - `review-integration-managed` — `configuration_id` is set. Rotation is driven by the integration, not by editing the var directly.
  - `review-unclassified` — provider classification is `Unknown`; human eyeballs required to decide whether this key is a secret and, if so, which vendor to rotate at.
- **`backup_deploy_count_90d`** — how many deployments the backup owner made in the lookback window. Higher = stronger ownership signal. Reads against `backup_owner_name` — if it says `3`, interpret as "this person did 3 of the last-90-days deploys." Use alongside project activity (a 3 on a quiet project is strong; on a busy project it's noise).
- **`last_updated_days_ago`** — prioritize: stale (>180d) secrets are often abandoned integrations; fresh (<7d) ones mean someone knows them well.
- **`vercel_url`** — direct deep-link to the project's environment-variables settings page. One click to edit after rotation.

### Post-rotation PATCH recipe (out of scope for this tool)

Once the vendor-side rotation is complete and the new value is deployed in Vercel, mark the var `sensitive` so it cannot leak via the same vector:

```bash
curl -X PATCH \
  "https://api.vercel.com/v9/projects/${PROJECT_ID}/env/${ENV_ID}?teamId=${TEAM_ID}" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"sensitive"}'
```

The CSV has `project_id`, `env_id`, and (via `team_slug` → look up the team ID once) everything you need. Build your rotation script from the CSV; this tool won't do it for you.
