// Whose PRs agents read, and run, with no click from the reviewer: a PR's text and code can try to steer them.
import type { ReviewMeta } from "../src/store";
import type { ReviewPreferences } from "./review-preferences";
import type { Knobs } from "./knobs";

/** GitHub's author associations for the repository's owner, its organization's members, and its collaborators. */
const MEMBERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

type Trust = Pick<ReviewMeta, "kind" | "ownPr" | "authorAssociation" | "approvedHead" | "approvedAt" | "prEditedAt" | "foreignHeadOwner">;
type TrustSettings = Pick<ReviewPreferences, "unattendedAuthors"> & { knobs?: Pick<Knobs, "unattendedAgents"> };

/**
 * Whether the PR's author is trusted by the setting. Your own PRs and local reviews are; an association not read yet isn't.
 * A head branch in someone else's fork isn't, whoever opened the PR: that fork's owner can push to it.
 */
export function trustedAuthor(review: Trust, preferences: Pick<ReviewPreferences, "unattendedAuthors">): boolean {
  if (review.kind !== "pr" || preferences.unattendedAuthors === "anyone") return true;
  return typeof review.foreignHeadOwner !== "string" && (review.ownPr === true || MEMBERS.has(review.authorAssociation ?? ""));
}

/** You started agents on the review at `head`: the lifecycle that approves it. */
export function approve(head: string | null, now: number): Pick<ReviewMeta, "approvedHead" | "approvedAt"> {
  return { approvedHead: head, approvedAt: now };
}

/**
 * Whether agents may start on the review at `head` with no click: a trusted author, or you started agents on that
 * head and the PR's text wasn't edited since.
 */
export function mayRunUnattended(review: Trust, preferences: TrustSettings, head: string | null | undefined): boolean {
  // Off, only your own PRs and local reviews start without a click.
  const trusted = preferences.knobs?.unattendedAgents === false
    ? review.kind !== "pr" || review.ownPr === true && typeof review.foreignHeadOwner !== "string"
    : trustedAuthor(review, preferences);
  const unedited = review.prEditedAt == null || review.approvedAt != null && review.prEditedAt <= review.approvedAt;
  return trusted || !!head && review.approvedHead === head && unedited;
}

/** Why a run waits for your click when the author is trusted: Start agents on their own is off. */
export function skipWhy(review: Trust, preferences: TrustSettings): { why?: "settings" } {
  return preferences.knobs?.unattendedAgents === false && trustedAuthor(review, preferences) ? { why: "settings" } : {};
}

/** Whether the review agent may run the repo's checks, which runs the PR's code: turned on, and a trusted author. A click never allows it. */
export function mayRunChecks(review: Trust, preferences: Pick<ReviewPreferences, "unattendedAuthors" | "runRepoChecks">): boolean {
  return preferences.runRepoChecks && review.kind === "pr" && trustedAuthor(review, preferences);
}

/**
 * Why a run didn't start on its own, with `knobs` the current settings. A member's run skipped before the sync read the
 * association was skipped for that.
 */
export function notRunReason(review: Pick<ReviewMeta, "author" | "repo" | "authorAssociation" | "foreignHeadOwner" | "skippedRun">, knobs: Pick<Knobs, "unattendedAgents">): string {
  if (review.skippedRun?.why === "settings") {
    return knobs.unattendedAgents ? "Not run automatically: Start agents on their own was off in Settings when this came in" : "Not run automatically: Start agents on their own is off in Settings";
  }
  if (typeof review.foreignHeadOwner === "string") return `Not run automatically: this PR’s branch is in ${review.foreignHeadOwner ? `@${review.foreignHeadOwner}’s` : "someone else’s"} fork`;
  if (review.authorAssociation === undefined || MEMBERS.has(review.authorAssociation ?? "")) return "Not run automatically: GitHub hadn’t said who wrote this PR yet";
  return `Not run automatically: ${review.author ? `@${review.author}` : "the author"} isn’t a member of ${review.repo?.split("/")[0] ?? "the repository"}`;
}
