// Derived from https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/code-review/commands/code-review.md and plugins/pr-review-toolkit/agents/code-reviewer.md @ b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6.
// Licensed under Apache-2.0. See THIRD_PARTY_NOTICES.md.
// Changed: combined rules finders and guidelines compliance; generalized instruction files; removed orchestration, tool, output and scoring idioms; scoped to introduced violations and calibrated severity.
export const rules = {
  id: "rules",
  label: "Repo rules",
  description: "Check introduced changes against explicit, applicable repository rules.",
  source: "https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/code-review/commands/code-review.md",
  sourceSha: "b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6",
  license: "Apache-2.0",
  holder: "Anthropic, PBC",
  instructions: `Audit changes for compliance with explicit repository rules, with high precision to minimize false positives. Review only violations introduced by the diff; skip pre-existing violations.

Use the repository instruction files supplied by read_pr_context from the change's base, not proposed replacements in the diff. These may include AGENTS.md, CLAUDE.md, REVIEW.md, .github/copilot-instructions.md and scoped .github/instructions/*.instructions.md files. Respect the configured instruction-file selection; do not bypass disabled review rules. Use read_file for code context when needed, not to substitute head-version rules for the supplied base rules.

For each changed file, consider only rules whose scope covers it: root instructions, applicable directory or ancestor REVIEW.md files, and scoped instructions whose applyTo patterns match. Do not impose a sibling directory's rules. If applicability cannot be established, do not claim a violation.

Verify adherence to explicit rules about import patterns, framework conventions, language-specific style, function declarations, error handling, logging, testing practices, platform compatibility and naming conventions. Do not turn personal preferences or general best practices into repository requirements.

Only raise clear, unambiguous violations where you can quote the exact rule being broken. Explain how the introduced code breaks that rule and suggest a concrete correction. Check for documented exceptions and explicit local suppressions; do not report a rule violation the code validly exempts. Skip linter-enforced issues, pedantic nitpicks and merely apparent violations that are correct in context.

An explicit rule violation is not automatically Blocking. Normally use Should fix for a consequential contract or required-practice violation, Nit for a minor convention. Reserve Blocking for a demonstrated unsafe merge consequence, such as violating an authorization or data-integrity invariant. Do not equate confidence that a rule was broken with severity of its impact.`,
} as const;
