import type { EnvVar } from "./vercel.js";

export type Recommendation =
	| "rotate"
	| "skip-public-client-side"
	| "review-integration-managed"
	| "review-unclassified";

/**
 * Derive a rotation recommendation from the env var's metadata + inferred provider.
 * Strictly a heuristic — the reviewer has the final say.
 */
export function recommendFor(env: EnvVar, provider: string): Recommendation {
	// Integration-managed env vars (Stripe/Postgres/etc. connected via Vercel
	// integration marketplace) have a configurationId; rotation is driven by
	// the integration, not by editing the Vercel env var directly.
	if (env.configurationId) return "review-integration-managed";

	// Public client-side keys are shipped to the browser by design. The
	// incident didn't change that threat model. Reviewer still sees the row
	// in case of misuse / domain-unrestricted public keys.
	if (provider === "Public (client-side)") return "skip-public-client-side";

	// Unknown provider → manual classification needed. Explicitly labelled
	// "unclassified" rather than bare "review" so reviewers aren't ambiguous
	// about what to review for.
	if (provider === "Unknown") return "review-unclassified";

	return "rotate";
}
