import { test } from "node:test";
import assert from "node:assert/strict";
import { inferProvider } from "../src/providers.js";

test("inferProvider: Stripe prefix", () => {
	assert.equal(inferProvider("STRIPE_SECRET_KEY"), "Stripe");
	assert.equal(inferProvider("STRIPE_WEBHOOK_SECRET"), "Stripe");
});

test("inferProvider: AWS / S3 prefixes", () => {
	assert.equal(inferProvider("AWS_ACCESS_KEY_ID"), "AWS");
	assert.equal(inferProvider("AWS_SECRET_ACCESS_KEY"), "AWS");
	assert.equal(inferProvider("S3_BUCKET"), "AWS");
});

test("inferProvider: Postgres (DATABASE_URL and POSTGRES_/PG_ prefixes)", () => {
	assert.equal(inferProvider("DATABASE_URL"), "Postgres");
	assert.equal(inferProvider("POSTGRES_PASSWORD"), "Postgres");
	assert.equal(inferProvider("PG_HOST"), "Postgres");
});

test("inferProvider: LLM providers", () => {
	assert.equal(inferProvider("OPENAI_API_KEY"), "OpenAI");
	assert.equal(inferProvider("ANTHROPIC_API_KEY"), "Anthropic");
	assert.equal(inferProvider("CLAUDE_API_KEY"), "Anthropic");
});

test("inferProvider: Public client-side prefixes", () => {
	assert.equal(inferProvider("NEXT_PUBLIC_ANALYTICS_ID"), "Public (client-side)");
	assert.equal(inferProvider("VITE_API_URL"), "Public (client-side)");
	assert.equal(inferProvider("PUBLIC_MAP_TOKEN"), "Public (client-side)");
});

test("inferProvider: NEXT_PUBLIC_ wins over secret-substring fallback", () => {
	// If the rule order were reversed, these keys would match Unknown-secret.
	// The semantic intent: client-exposed keys (e.g., Stripe publishable) should
	// be labeled as public, not as a secret.
	assert.equal(inferProvider("NEXT_PUBLIC_STRIPE_KEY"), "Public (client-side)");
	assert.equal(inferProvider("NEXT_PUBLIC_SOMETHING_TOKEN"), "Public (client-side)");
});

test("inferProvider: secret-keyword fallback", () => {
	assert.equal(inferProvider("MY_SECRET"), "Unknown-secret");
	assert.equal(inferProvider("SOMETHING_TOKEN"), "Unknown-secret");
	assert.equal(inferProvider("ADMIN_PASSWORD"), "Unknown-secret");
	assert.equal(inferProvider("API_KEY"), "Unknown-secret");
	assert.equal(inferProvider("VENDOR_CREDENTIAL"), "Unknown-secret");
});

test("inferProvider: unmatched keys default to Unknown", () => {
	assert.equal(inferProvider("LOG_LEVEL"), "Unknown");
	assert.equal(inferProvider("NODE_ENV"), "Unknown");
});

test("inferProvider: bot-adjacent prefixes route correctly", () => {
	assert.equal(inferProvider("GITHUB_TOKEN"), "GitHub");
	assert.equal(inferProvider("GH_PAT"), "GitHub");
	assert.equal(inferProvider("SENTRY_DSN"), "Sentry");
	assert.equal(inferProvider("DD_API_KEY"), "Datadog");
});

test("inferProvider: additional storage/queue providers", () => {
	assert.equal(inferProvider("MONGODB_URI"), "MongoDB");
	assert.equal(inferProvider("KV_URL"), "Vercel KV");
	assert.equal(inferProvider("BLOB_READ_WRITE_TOKEN"), "Vercel Blob");
	assert.equal(inferProvider("UPSTASH_REDIS_REST_URL"), "Redis/Upstash");
});

test("inferProvider: email/messaging vendors", () => {
	assert.equal(inferProvider("SENDGRID_API_KEY"), "Email provider");
	assert.equal(inferProvider("POSTMARK_SERVER_TOKEN"), "Email provider");
	assert.equal(inferProvider("RESEND_API_KEY"), "Email provider");
	assert.equal(inferProvider("TWILIO_AUTH_TOKEN"), "Twilio");
	assert.equal(inferProvider("SLACK_WEBHOOK_URL"), "Slack");
});

test("inferProvider: auth vendors", () => {
	assert.equal(inferProvider("CLERK_SECRET_KEY"), "Clerk");
	assert.equal(inferProvider("AUTH0_CLIENT_SECRET"), "Auth0");
	assert.equal(inferProvider("SUPABASE_SERVICE_ROLE_KEY"), "Supabase");
	assert.equal(inferProvider("NEXTAUTH_SECRET"), "NextAuth");
	assert.equal(inferProvider("JWT_SECRET"), "JWT signing");
});

test("inferProvider: Cloudflare prefixes", () => {
	assert.equal(inferProvider("CLOUDFLARE_API_TOKEN"), "Cloudflare");
	assert.equal(inferProvider("CF_API_TOKEN"), "Cloudflare");
});

test("inferProvider: rules are case-sensitive (lowercase keys fall through)", () => {
	// Documents current behavior: lowercase env var names are not matched.
	assert.equal(inferProvider("stripe_secret_key"), "Unknown");
});

test("inferProvider: empty string returns Unknown", () => {
	assert.equal(inferProvider(""), "Unknown");
});

test("inferProvider: first-match-wins — Stripe rule beats generic secret fallback", () => {
	// STRIPE_SECRET_KEY would also match the (SECRET|TOKEN|…) fallback,
	// but Stripe appears first in the rule list.
	assert.equal(inferProvider("STRIPE_SECRET_KEY"), "Stripe");
});

test("inferProvider: analytics/observability vendors", () => {
	assert.equal(inferProvider("SEGMENT_WRITE_KEY"), "Segment");
	assert.equal(inferProvider("MIXPANEL_TOKEN"), "Mixpanel");
	assert.equal(inferProvider("AMPLITUDE_API_KEY"), "Amplitude");
	assert.equal(inferProvider("POSTHOG_KEY"), "PostHog");
	assert.equal(inferProvider("HONEYCOMB_API_KEY"), "Honeycomb");
	assert.equal(inferProvider("NEW_RELIC_LICENSE_KEY"), "New Relic");
	assert.equal(inferProvider("NR_API_KEY"), "New Relic");
});

test("inferProvider: feature flag vendors", () => {
	assert.equal(inferProvider("LAUNCHDARKLY_SDK_KEY"), "LaunchDarkly");
	assert.equal(inferProvider("LD_CLIENT_ID"), "LaunchDarkly");
	assert.equal(inferProvider("STATSIG_SERVER_KEY"), "Statsig");
	assert.equal(inferProvider("GROWTHBOOK_API_HOST"), "GrowthBook");
});

test("inferProvider: commerce + payments vendors", () => {
	assert.equal(inferProvider("PLAID_CLIENT_ID"), "Plaid");
	assert.equal(inferProvider("PADDLE_VENDOR_ID"), "Paddle");
	assert.equal(inferProvider("SHOPIFY_ADMIN_API_KEY"), "Shopify");
	assert.equal(inferProvider("SQUARE_ACCESS_TOKEN"), "Square");
});

test("inferProvider: CRM / support vendors", () => {
	assert.equal(inferProvider("INTERCOM_ACCESS_TOKEN"), "Intercom");
	assert.equal(inferProvider("BRAZE_API_KEY"), "Braze");
	assert.equal(inferProvider("HUBSPOT_API_KEY"), "HubSpot");
	assert.equal(inferProvider("LINEAR_API_KEY"), "Linear");
	assert.equal(inferProvider("NOTION_API_KEY"), "Notion");
});

test("inferProvider: AI / vector store vendors", () => {
	assert.equal(inferProvider("PINECONE_API_KEY"), "Pinecone");
	assert.equal(inferProvider("COHERE_API_KEY"), "Cohere");
	assert.equal(inferProvider("HUGGINGFACE_TOKEN"), "HuggingFace");
	assert.equal(inferProvider("REPLICATE_API_TOKEN"), "Replicate");
});

test("inferProvider: data platform vendors", () => {
	assert.equal(inferProvider("SNOWFLAKE_PASSWORD"), "Snowflake");
	assert.equal(inferProvider("BIGQUERY_CREDENTIALS"), "BigQuery");
	assert.equal(inferProvider("BQ_PROJECT_ID"), "BigQuery");
	assert.equal(inferProvider("DATABRICKS_TOKEN"), "Databricks");
});
