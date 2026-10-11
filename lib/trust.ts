// Whose PRs agents read, and run, with no click from the reviewer: a PR's text and code can try to steer them.
import type { ReviewMeta } from "../src/store";
import type { ReviewPreferences } from "./review-preferences";

/** GitHub's author associations for the repository's owner, its organization's members, and its collaborators. */
const MEMBERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

type Trust = Pick<ReviewMeta, "kind" | "ownPr" | "authorAssociation" | "approvedHead">;

/** Whether the PR's author is trusted by the setting. Your own PRs and local reviews are; an association not read yet isn't. */
export function trustedAuthor(review: Trust, preferences: Pick<ReviewPreferences, "unattendedAuthors">): boolean {
  return review.kind !== "pr" || review.ownPr === true || preferences.unattendedAuthors === "anyone" || MEMBERS.has(review.authorAssociation ?? "");
}

/** Whether agents may start on the review at `head` with no click: a trusted author, or you started agents on that head. */
export function mayRunUnattended(review: Trust, preferences: Pick<ReviewPreferences, "unattendedAuthors">, head: string | null | undefined): boolean {
  return trustedAuthor(review, preferences) || !!head && review.approvedHead === head;
}

/** Whether the review agent may run the repo's checks, which runs the PR's code: turned on, and a trusted author. A click never allows it. */
export function mayRunChecks(review: Trust, preferences: Pick<ReviewPreferences, "unattendedAuthors" | "runRepoChecks">): boolean {
  return preferences.runRepoChecks && review.kind === "pr" && trustedAuthor(review, preferences);
}

/** Why a run didn't start on its own. A member's run skipped before the sync read the association was skipped for that. */
export function notRunReason(review: Pick<ReviewMeta, "author" | "repo" | "authorAssociation">): string {
  if (review.authorAssociation === undefined || MEMBERS.has(review.authorAssociation ?? "")) return "Not run automatically: GitHub hadn’t said who wrote this PR yet";
  return `Not run automatically: ${review.author ? `@${review.author}` : "the author"} isn’t a member of ${review.repo?.split("/")[0] ?? "the repository"}`;
}
