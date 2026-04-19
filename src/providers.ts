type Rule = { match: (key: string) => boolean; provider: string };

const rules: Rule[] = [
	{ match: (k) => k.startsWith("STRIPE_"), provider: "Stripe" },
	{ match: (k) => k.startsWith("AWS_") || k.startsWith("S3_"), provider: "AWS" },
	{ match: (k) => k.startsWith("GCP_") || k.startsWith("GOOGLE_APPLICATION_"), provider: "Google Cloud" },
	{ match: (k) => k === "DATABASE_URL" || k.startsWith("POSTGRES_") || k.startsWith("PG_"), provider: "Postgres" },
	{ match: (k) => k.startsWith("MONGO") || k.startsWith("MONGODB_"), provider: "MongoDB" },
	{ match: (k) => k.startsWith("REDIS_") || k.startsWith("UPSTASH_"), provider: "Redis/Upstash" },
	{ match: (k) => k.startsWith("KV_"), provider: "Vercel KV" },
	{ match: (k) => k.startsWith("BLOB_"), provider: "Vercel Blob" },
	{ match: (k) => k.startsWith("OPENAI_"), provider: "OpenAI" },
	{ match: (k) => k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_"), provider: "Anthropic" },
	{ match: (k) => k.startsWith("SENTRY_"), provider: "Sentry" },
	{ match: (k) => k.startsWith("DATADOG_") || k.startsWith("DD_"), provider: "Datadog" },
	{ match: (k) => k.startsWith("GITHUB_") || k.startsWith("GH_"), provider: "GitHub" },
	{ match: (k) => k.startsWith("GITLAB_"), provider: "GitLab" },
	{ match: (k) => k.startsWith("CLERK_"), provider: "Clerk" },
	{ match: (k) => k.startsWith("AUTH0_"), provider: "Auth0" },
	{ match: (k) => k.startsWith("SUPABASE_"), provider: "Supabase" },
	{ match: (k) => k.startsWith("FIREBASE_"), provider: "Firebase" },
	{ match: (k) => k.startsWith("NEXTAUTH_"), provider: "NextAuth" },
	{ match: (k) => k.startsWith("JWT_"), provider: "JWT signing" },
	{ match: (k) => k.startsWith("SENDGRID_") || k.startsWith("MAILGUN_") || k.startsWith("POSTMARK_") || k.startsWith("RESEND_"), provider: "Email provider" },
	{ match: (k) => k.startsWith("TWILIO_"), provider: "Twilio" },
	{ match: (k) => k.startsWith("SLACK_"), provider: "Slack" },
	{ match: (k) => k.startsWith("DISCORD_"), provider: "Discord" },
	{ match: (k) => k.startsWith("ALGOLIA_"), provider: "Algolia" },
	{ match: (k) => k.startsWith("CLOUDFLARE_") || k.startsWith("CF_"), provider: "Cloudflare" },
	// Analytics / observability / product
	{ match: (k) => k.startsWith("SEGMENT_"), provider: "Segment" },
	{ match: (k) => k.startsWith("MIXPANEL_"), provider: "Mixpanel" },
	{ match: (k) => k.startsWith("AMPLITUDE_"), provider: "Amplitude" },
	{ match: (k) => k.startsWith("POSTHOG_"), provider: "PostHog" },
	{ match: (k) => k.startsWith("HEAP_"), provider: "Heap" },
	{ match: (k) => k.startsWith("HONEYCOMB_") || k.startsWith("HNY_"), provider: "Honeycomb" },
	{ match: (k) => k.startsWith("NEW_RELIC_") || k.startsWith("NEWRELIC_") || k.startsWith("NR_"), provider: "New Relic" },
	{ match: (k) => k.startsWith("ROLLBAR_"), provider: "Rollbar" },
	{ match: (k) => k.startsWith("BUGSNAG_"), provider: "Bugsnag" },
	{ match: (k) => k.startsWith("LOGTAIL_") || k.startsWith("BETTERSTACK_"), provider: "BetterStack / Logtail" },
	// Feature flags
	{ match: (k) => k.startsWith("LAUNCHDARKLY_") || k.startsWith("LD_"), provider: "LaunchDarkly" },
	{ match: (k) => k.startsWith("STATSIG_"), provider: "Statsig" },
	{ match: (k) => k.startsWith("SPLIT_IO_"), provider: "Split.io" },
	{ match: (k) => k.startsWith("GROWTHBOOK_"), provider: "GrowthBook" },
	// Payments / billing
	{ match: (k) => k.startsWith("PLAID_"), provider: "Plaid" },
	{ match: (k) => k.startsWith("PADDLE_"), provider: "Paddle" },
	{ match: (k) => k.startsWith("LEMONSQUEEZY_"), provider: "LemonSqueezy" },
	// Commerce
	{ match: (k) => k.startsWith("SHOPIFY_"), provider: "Shopify" },
	{ match: (k) => k.startsWith("SQUARE_"), provider: "Square" },
	// Support / CRM / messaging
	{ match: (k) => k.startsWith("INTERCOM_"), provider: "Intercom" },
	{ match: (k) => k.startsWith("BRAZE_"), provider: "Braze" },
	{ match: (k) => k.startsWith("CUSTOMERIO_") || k.startsWith("CUSTOMER_IO_"), provider: "Customer.io" },
	{ match: (k) => k.startsWith("HUBSPOT_"), provider: "HubSpot" },
	{ match: (k) => k.startsWith("ZENDESK_"), provider: "Zendesk" },
	{ match: (k) => k.startsWith("LINEAR_"), provider: "Linear" },
	{ match: (k) => k.startsWith("NOTION_"), provider: "Notion" },
	// Maps / media
	{ match: (k) => k.startsWith("MAPBOX_"), provider: "Mapbox" },
	{ match: (k) => k.startsWith("CLOUDINARY_"), provider: "Cloudinary" },
	// AI / ML / vector
	{ match: (k) => k.startsWith("PINECONE_"), provider: "Pinecone" },
	{ match: (k) => k.startsWith("COHERE_"), provider: "Cohere" },
	{ match: (k) => k.startsWith("HUGGINGFACE_") || k.startsWith("HF_"), provider: "HuggingFace" },
	{ match: (k) => k.startsWith("REPLICATE_"), provider: "Replicate" },
	// Data platforms
	{ match: (k) => k.startsWith("SNOWFLAKE_"), provider: "Snowflake" },
	{ match: (k) => k.startsWith("BIGQUERY_") || k.startsWith("BQ_"), provider: "BigQuery" },
	{ match: (k) => k.startsWith("DATABRICKS_"), provider: "Databricks" },
	// Misc infra
	{ match: (k) => k.startsWith("PUSHER_"), provider: "Pusher" },
	{ match: (k) => k.startsWith("ABLY_"), provider: "Ably" },
	{ match: (k) => k.startsWith("TURBO_"), provider: "Turborepo" },
	{ match: (k) => k.startsWith("NEXT_PUBLIC_") || k.startsWith("VITE_") || k.startsWith("PUBLIC_"), provider: "Public (client-side)" },
	{ match: (k) => /(SECRET|TOKEN|KEY|PASS|PASSWORD|CREDENTIAL)/.test(k), provider: "Unknown-secret" },
];

export function inferProvider(key: string): string {
	for (const rule of rules) {
		if (rule.match(key)) return rule.provider;
	}
	return "Unknown";
}
