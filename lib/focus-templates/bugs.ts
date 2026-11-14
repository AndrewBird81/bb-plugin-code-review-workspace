// Derived from https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/code-review/commands/code-review.md @ b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6.
// Licensed under Apache-2.0. See THIRD_PARTY_NOTICES.md.
// Changed: combined bug finders, high-signal criteria and false-positive filters; removed orchestration, posting and output idioms; left rule compliance to Repo rules; calibrated severity.
export const bugs = {
  id: "bugs",
  label: "Bugs",
  description: "An independent second bug pass, intentionally overlapping the review agent's own review.",
  source: "https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/code-review/commands/code-review.md",
  sourceSha: "b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6",
  license: "Apache-2.0",
  licenseFile: "LICENSES/Apache-2.0-claude-plugins-official.txt",
  holder: "Anthropic, PBC",
  instructions: `Scan for obvious, significant bugs in introduced code. This is an independent second pass over correctness, intentionally overlapping the review agent's own review. Skip pre-existing issues.

Focus on the diff itself. A candidate must be demonstrable from the changed code, not a conjecture that requires unseen context. Read surrounding code to disprove a candidate or confirm its meaning when needed; do not broaden the search into unrelated code.

Keep only HIGH SIGNAL issues:
- Code that will fail to compile or parse: syntax errors, type errors, missing imports or unresolved references, unless ordinary automated checks already catch it.
- Clear logic errors that definitely produce wrong results regardless of inputs.
- Problems in introduced code with an unambiguous failure.

Do NOT flag:
- Potential issues that depend on specific inputs or state, or require assumptions outside the diff.
- Code style or quality concerns, subjective suggestions or improvements.
- Something that appears to be a bug but is actually correct in context.
- Pedantic nitpicks that a senior engineer would not flag.
- Issues a linter will catch.
- General code quality concerns, such as lack of test coverage or generic security advice. Leave exact-rule compliance to the Repo rules focus.
- Issues explicitly silenced under an applicable repository rule, such as a valid lint-ignore comment.

If you are not certain an issue is real, do not flag it. False positives erode trust and waste reviewer time. Verify the proposed correction actually fixes the entire issue rather than moving it elsewhere.

Use Should fix for a definite functional defect. Reserve Blocking for a change that cannot safely merge, such as an unconditional failure of a required execution path or confirmed data corruption. Do not upgrade a defect merely because it is obvious; omit speculative questions and optional polish from this pass.`,
} as const;
