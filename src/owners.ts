import type { Deployment, TeamMember } from "./vercel.js";

export type Owner = { uid: string; name: string; email: string };

const KNOWN_BOT_USERNAMES = new Set(["vercel", "vercel-bot", "github-actions[bot]", "dependabot[bot]", "renovate[bot]"]);

function isBot(creator: { uid?: string; username?: string } | undefined): boolean {
	if (!creator) return true;
	const u = creator.username ?? "";
	if (!u) return true;
	if (KNOWN_BOT_USERNAMES.has(u)) return true;
	if (u.includes("[bot]")) return true;
	return false;
}

export function resolveOwner(uid: string | undefined, members: Map<string, TeamMember>): Owner {
	if (!uid) return { uid: "", name: "", email: "" };
	const m = members.get(uid);
	if (!m) return { uid, name: uid, email: "" };
	return {
		uid,
		name: m.name ?? m.username ?? uid,
		email: m.email ?? "",
	};
}

/**
 * Returns UIDs of human deployers ranked by deploy count (desc), ties broken by
 * most-recent deployment.
 */
export function rankDeployers(deployments: readonly Deployment[]): string[] {
	const counts = new Map<string, { count: number; mostRecent: number }>();
	for (const d of deployments) {
		if (isBot(d.creator)) continue;
		const uid = d.creator?.uid;
		if (!uid) continue;
		const cur = counts.get(uid) ?? { count: 0, mostRecent: 0 };
		cur.count += 1;
		if (d.createdAt > cur.mostRecent) cur.mostRecent = d.createdAt;
		counts.set(uid, cur);
	}
	return [...counts.entries()]
		.sort((a, b) => {
			if (b[1].count !== a[1].count) return b[1].count - a[1].count;
			return b[1].mostRecent - a[1].mostRecent;
		})
		.map(([uid]) => uid);
}

export function pickBackupOwner(
	rankedDeployers: readonly string[],
	primaryUid: string | undefined,
	members: Map<string, TeamMember>,
): Owner | null {
	for (const uid of rankedDeployers) {
		if (uid && uid !== primaryUid) return resolveOwner(uid, members);
	}
	return null;
}
