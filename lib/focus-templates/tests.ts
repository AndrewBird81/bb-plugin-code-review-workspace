// Derived from https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/pr-review-toolkit/agents/pr-test-analyzer.md @ b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6.
// Licensed under Apache-2.0. See THIRD_PARTY_NOTICES.md.
// Changed: kept behavioral coverage and pragmatic gap analysis; removed invocation, praise, output and numeric ratings; generalized project rules; scoped to diff-introduced gaps and calibrated severity.
export const tests = {
  id: "tests",
  label: "Tests",
  description: "Find consequential behavioral coverage gaps introduced by the change.",
  source: "https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/pr-review-toolkit/agents/pr-test-analyzer.md",
  sourceSha: "b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6",
  license: "Apache-2.0",
  licenseFile: "LICENSES/Apache-2.0-claude-plugins-official.txt",
  holder: "Anthropic, PBC",
  instructions: `Analyze test coverage quality for functionality added or changed in the diff, not academic completeness or 100% line coverage. Report only consequential gaps the change introduces, or existing coverage it invalidates or removes. Skip unrelated pre-existing missing tests.

First understand the changed behavior and its contracts. Map accompanying and existing tests to that behavior, including integration tests that may already cover it. Follow the repository's applicable testing standards rather than inventing a new testing policy.

Look for critical gaps:
- Untested error handling that could cause silent failures.
- Boundary conditions and meaningful edge cases in changed logic.
- Uncovered critical business logic branches.
- Missing negative cases for validation.
- Concurrent or asynchronous behavior where ordering, cancellation or retries affect correctness.
- Changed integration points whose contracts are no longer exercised.
- Removed assertions, skipped tests or weakened expectations that allow a meaningful regression through.

Evaluate whether changed tests verify observable behavior and contracts rather than implementation details. Would they fail on a meaningful regression? Would they survive a reasonable refactor? Consider descriptive, meaningful test setup and names only when ambiguity hides what is being asserted, not as a style review.

For each suggested test, state a specific failure it would catch, the setup or input, and the expected observable result. Explain which changed behavior is otherwise unprotected. Check existing tests before claiming absence, and do not equate lack of a new test file with lack of coverage. Avoid requests for trivial getters/setters without logic, exhaustive combinations with no plausible consequence, or tests costing more than the risk warrants.

Use Should fix for a concrete missing regression guard around important changed behavior, especially error paths, validation and user-facing business rules. Missing tests alone are not proof of a production defect. Reserve Blocking for loss of a required safety gate protecting demonstrated data-loss, security or system-failure risk. Optional edge coverage or test clarity is at most Nit; omit nice-to-have completeness suggestions.`,
} as const;
