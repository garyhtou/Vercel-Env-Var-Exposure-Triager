import { test } from "node:test";
import assert from "node:assert/strict";
import { recommendFor } from "../src/recommendation.js";
import type { EnvVar } from "../src/vercel.js";

const baseEnv: EnvVar = { id: "e", key: "STRIPE_SECRET_KEY", type: "plain", target: ["production"] };

test("recommendFor: integration-managed when configurationId is present", () => {
	assert.equal(recommendFor({ ...baseEnv, configurationId: "cfg_123" }, "Stripe"), "review-integration-managed");
});

test("recommendFor: skip-public-client-side for NEXT_PUBLIC_ / VITE_ / PUBLIC_", () => {
	assert.equal(recommendFor(baseEnv, "Public (client-side)"), "skip-public-client-side");
});

test("recommendFor: rotate for named providers", () => {
	assert.equal(recommendFor(baseEnv, "Stripe"), "rotate");
	assert.equal(recommendFor(baseEnv, "AWS"), "rotate");
	assert.equal(recommendFor(baseEnv, "Postgres"), "rotate");
});

test("recommendFor: rotate for Unknown-secret", () => {
	assert.equal(recommendFor(baseEnv, "Unknown-secret"), "rotate");
});

test("recommendFor: review-unclassified for Unknown (can't tell if it's a secret)", () => {
	assert.equal(recommendFor(baseEnv, "Unknown"), "review-unclassified");
});

test("recommendFor: configurationId overrides public classification", () => {
	// An integration-connected var that also happens to be client-prefixed should
	// still route through integration review.
	assert.equal(
		recommendFor({ ...baseEnv, key: "NEXT_PUBLIC_WHATEVER", configurationId: "cfg_x" }, "Public (client-side)"),
		"review-integration-managed",
	);
});
