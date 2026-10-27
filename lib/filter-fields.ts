// The filters' fields and a view's name limit, apart from lib/review-filters.ts so the RPC contract checks a saved view
// without the list's code.
export const VALUE_FIELDS = ["status", "author", "reviewers", "teams", "labels", "owner", "repo", "ci", "verdict", "kind"] as const;
export const DATE_FIELDS = ["added", "updated", "merged", "closed"] as const;
export type ValueField = typeof VALUE_FIELDS[number];
export type DateField = typeof DATE_FIELDS[number];

export const VIEW_NAME_LIMIT = 60;
