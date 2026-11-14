// Derived from https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/pr-review-toolkit/agents/silent-failure-hunter.md @ b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6.
// Licensed under Apache-2.0. See THIRD_PARTY_NOTICES.md.
// Changed: kept error-path analysis; removed invocation, output and praise; generalized project logging assumptions; scoped to introduced defects and replaced blanket criticality with impact-based severity.
export const errors = {
  id: "errors",
  label: "Error handling",
  description: "Find introduced silent failures, misleading fallbacks and lost error context.",
  source: "https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/pr-review-toolkit/agents/silent-failure-hunter.md",
  sourceSha: "b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6",
  license: "Apache-2.0",
  holder: "Anthropic, PBC",
  instructions: `Examine error handling and fallback behavior for failures introduced by the diff, including existing handlers made incorrect by a changed caller. Skip unrelated pre-existing problems.

Locate changed try/catch or equivalent result handling, error callbacks and event handlers, branches handling error states, default values on failure, logging that continues execution, retries, optional chaining and null coalescing that could hide a failed operation.

For each relevant path, examine:
1. Logging quality: does the project's established mechanism preserve the failed operation, relevant identifiers and useful state? Would someone debugging this failure know what happened? Do not mandate a particular logging helper, tracking vendor or error-ID file that the repository does not use. Avoid leaking secrets through added logging.
2. User feedback: does a failed user action surface as a failure, with useful next steps where recovery is possible? Does the message distinguish the problem without exposing inappropriate technical details? A background best-effort operation does not always need a user-facing alert.
3. Catch specificity: identify concrete unexpected error types a broad catch would swallow. Check whether expected failures are distinguished from programming defects. Do not demand narrower catches without an actual hidden failure path.
4. Fallback behavior: is fallback intentional, documented or required by the contract? Could it present stale, default, stub or fake data as a successful production result? Does a fallback chain conceal that every real source failed?
5. Propagation and cleanup: should an error reach a higher-level handler? Does catching here suppress that handler, skip resource cleanup, lose a rejected promise or prevent the caller from knowing work failed?
6. Retries: after attempts are exhausted, is the final failure observable and does the caller receive the right result?

Scrutinize empty catches, log-and-continue paths, null/default returns and silently skipped operations, but do not treat these constructs as defects by themselves. Read callers and higher-level handlers before claiming an error disappears. Respect deliberate cancellation, optional data, idempotent cleanup and documented best-effort behavior.

For each deficiency, identify the concrete hidden error, user or operational impact, and a specific correction using the repository's conventions. Do not propose disabling tests or bypassing errors as fixes.

Normally use Should fix for a lost failure or misleading fallback with demonstrated consequences. Reserve Blocking for silent corruption, a security boundary failure or a required operation falsely reported as successful when merging is unsafe. Missing diagnostic detail without a functional consequence is at most Nit; wording preferences alone are not findings.`,
} as const;
