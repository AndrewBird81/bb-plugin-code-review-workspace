// The All reviews list's filters, as Linear has them: each picks a field and the values a review must have, or a time.
import type { IconName } from "../components/ui/icon";
import { reviewState, type ReviewItem } from "./review-state";
import { lastActivity } from "./status-line";

export type ValueField = "status" | "author" | "reviewers" | "teams" | "labels" | "owner" | "repo" | "ci" | "verdict" | "kind";
export type DateField = "added" | "updated" | "merged" | "closed";
export type FilterField = ValueField | DateField;

/** A review matches when it has any of `values` (none of them, `negate`), or its time is within `days` (`before`: longer ago). */
export type Filter =
  | { field: ValueField; values: string[]; negate?: boolean }
  | { field: DateField; days: number; before?: boolean };

export interface FieldInfo { field: FilterField; title: string; icon: IconName; noun: string }

/** The menu's fields, in its order, in groups. */
export const FIELD_GROUPS: FieldInfo[][] = [
  [
    { field: "status", title: "Status", icon: "Circle", noun: "statuses" },
    { field: "author", title: "Author", icon: "UserRound", noun: "authors" },
    { field: "reviewers", title: "Reviewers", icon: "UserRoundPlus", noun: "reviewers" },
    { field: "teams", title: "GitHub team reviewers", icon: "Layers", noun: "teams" },
    { field: "labels", title: "GitHub labels", icon: "ListView", noun: "labels" },
  ],
  [
    { field: "owner", title: "Repository owner", icon: "Github", noun: "owners" },
    { field: "repo", title: "Repository name", icon: "Folder", noun: "repositories" },
    { field: "kind", title: "Kind", icon: "GitBranch", noun: "kinds" },
    { field: "ci", title: "Checks", icon: "CircleCheck", noun: "check states" },
    { field: "verdict", title: "Your verdict", icon: "BadgeCheck", noun: "verdicts" },
  ],
  [
    { field: "added", title: "Added date", icon: "Calendar", noun: "" },
    { field: "updated", title: "Updated date", icon: "Calendar", noun: "" },
    { field: "merged", title: "Merged date", icon: "GitMerge", noun: "" },
    { field: "closed", title: "Closed date", icon: "GitPullRequestClosed", noun: "" },
  ],
];
export const FIELDS = new Map(FIELD_GROUPS.flat().map((info) => [info.field, info]));
const DATE_FIELDS = new Set<FilterField>(["added", "updated", "merged", "closed"]);
export const isDateField = (field: FilterField): field is DateField => DATE_FIELDS.has(field);

/** The spans a date filter offers, in days. */
export const DAY_CHOICES: Array<{ days: number; label: string }> = [
  { days: 1, label: "1 day" }, { days: 3, label: "3 days" }, { days: 7, label: "1 week" },
  { days: 14, label: "2 weeks" }, { days: 30, label: "1 month" }, { days: 90, label: "3 months" },
];
export const daysLabel = (days: number) => DAY_CHOICES.find((choice) => choice.days === days)?.label ?? `${days} days`;

const CI: Record<string, string> = { pass: "Passing", fail: "Failing", pending: "Pending", expected: "Expected" };
const VERDICT: Record<string, string> = { APPROVE: "Approved", REQUEST_CHANGES: "Changes requested", COMMENT: "Commented" };

/** The review's values for a field, as the menu shows them. */
export function valuesOf(review: ReviewItem, field: ValueField): string[] {
  const [owner, name] = review.repo?.split("/") ?? [];
  switch (field) {
    // As its row says it, but for whether the PR changed since your review: Approved · updated is Approved.
    case "status": return [reviewState(review).label.replace(/ · updated$/, "")];
    case "author": return review.author ? [review.author] : [];
    case "reviewers": return review.prReviewers ?? [];
    case "teams": return review.prTeams ?? [];
    case "labels": return (review.prLabels ?? []).map((label) => label.name);
    case "owner": return owner ? [owner] : [];
    case "repo": return name ? [name] : [];
    case "kind": return [review.kind === "ref" ? "Local" : "Pull request"];
    case "ci": { const ci = review.signals?.ci; return ci && CI[ci] ? [CI[ci]] : []; }
    case "verdict": return [review.submittedVerdict ? VERDICT[review.submittedVerdict] ?? "Not reviewed" : "Not reviewed"];
  }
}

/** When the review's field happened; null when it hasn't, as a PR not merged. Closed is without merging. */
export function timeOf(review: ReviewItem, field: DateField): number | null {
  switch (field) {
    case "added": return review.createdAt ?? null;
    case "updated": return review.prUpdatedAt ?? lastActivity(review);
    case "merged": return review.prMergedAt ?? null;
    // GitHub closes a PR as it merges it too.
    case "closed": return review.prState === "MERGED" ? null : review.prClosedAt ?? null;
  }
}

/** Every value the reviews have for a field, the most common first, with how many have it. */
export function choicesFor(reviews: readonly ReviewItem[], field: ValueField): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const review of reviews) for (const value of new Set(valuesOf(review, field))) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** A label's GitHub color, as a CSS color, from the reviews that carry it. */
export function labelColor(reviews: readonly ReviewItem[], name: string): string | null {
  for (const review of reviews) {
    const color = review.prLabels?.find((label) => label.name === name)?.color;
    if (color && /^[0-9a-f]{6}$/i.test(color)) return `#${color}`;
  }
  return null;
}

export function matchesFilter(review: ReviewItem, filter: Filter, now = Date.now()): boolean {
  if ("days" in filter) {
    const at = timeOf(review, filter.field);
    if (at == null) return false;
    const within = at >= now - filter.days * 86_400_000;
    return filter.before ? !within : within;
  }
  if (!filter.values.length) return true;
  const has = valuesOf(review, filter.field).some((value) => filter.values.includes(value));
  return filter.negate ? !has : has;
}

export const matchesFilters = (review: ReviewItem, filters: readonly Filter[], now = Date.now()) => filters.every((filter) => matchesFilter(review, filter, now));

/** The filters, kept for coming back to the list from a review, as the box's words are, so none outlasts the tab. */
const FILTERS_KEY = "gr:inbox-filters";

const validFilter = (f: any): f is Filter => !!f && FIELDS.has(f.field) && (isDateField(f.field)
  ? Number.isFinite(f.days) && f.days > 0 && (f.before === undefined || typeof f.before === "boolean")
  : Array.isArray(f.values) && f.values.every((value: unknown) => typeof value === "string") && (f.negate === undefined || typeof f.negate === "boolean"));

export function savedFilters(): Filter[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(FILTERS_KEY) ?? "[]");
    // One filter a field, as the bar makes them.
    return Array.isArray(saved) ? saved.filter(validFilter).filter((f, i, all) => all.findIndex((g) => g.field === f.field) === i) : [];
  } catch { return []; }
}

export function saveFilters(filters: readonly Filter[]): void {
  try { sessionStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch { /* best-effort */ }
}
