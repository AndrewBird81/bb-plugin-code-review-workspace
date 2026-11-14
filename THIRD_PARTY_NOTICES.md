# Third-party notices

## Docs template

- Source: [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official), Anthropic, PBC.
- Pinned revision: `dceb15d50832e6adf380bedc26dde03d251324b9` (HEAD when copied).
- Upstream file: [plugins/pr-review-toolkit/agents/comment-analyzer.md](https://github.com/anthropics/claude-plugins-official/blob/dceb15d50832e6adf380bedc26dde03d251324b9/plugins/pr-review-toolkit/agents/comment-analyzer.md).
- Derivative: `lib/focus-templates/docs.ts`.
- License: Apache-2.0; [verbatim plugin-directory LICENSE](LICENSES/Apache-2.0-claude-plugins-official.txt). The upstream LICENSE has no filled-in copyright holder; attribution here uses Anthropic, PBC. The source prompt has no copyright notice.
- Changed: removed frontmatter, invocation examples, output format and praise; scoped to the diff; added evidence and severity judgment; removed Claude/Anthropic, CLAUDE.md, request-access and Task-tool idioms; restated advisory-only scope. Attribution is metadata, not model-visible instructions. Modifications are covered by this repository's MIT license.

## Repo rules template

- Source: [upstream file](https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/code-review/commands/code-review.md), Anthropic, PBC.
- Pinned revision: `b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6`.
- Additional source: [guidelines compliance](https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/pr-review-toolkit/agents/code-reviewer.md).
- Derivative: `lib/focus-templates/rules.ts`.
- License: Apache-2.0; [verbatim plugin-directory LICENSE](LICENSES/Apache-2.0-claude-plugins-official.txt).
- Changed: combined rules finders and guidelines compliance; generalized instruction files; removed orchestration, tool, output and scoring idioms; scoped to introduced violations and calibrated severity. Attribution is metadata, not model-visible instructions. Modifications are covered by this repository's MIT license.

## Bugs template

- Source: [upstream file](https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/code-review/commands/code-review.md), Anthropic, PBC.
- Pinned revision: `b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6`.
- Derivative: `lib/focus-templates/bugs.ts`.
- License: Apache-2.0; [verbatim plugin-directory LICENSE](LICENSES/Apache-2.0-claude-plugins-official.txt).
- Changed: combined bug finders, high-signal criteria and false-positive filters; removed orchestration, posting and output idioms; left rule compliance to Repo rules; calibrated severity. Attribution is metadata, not model-visible instructions. Modifications are covered by this repository's MIT license.

## Error handling template

- Source: [upstream file](https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/pr-review-toolkit/agents/silent-failure-hunter.md), Anthropic, PBC.
- Pinned revision: `b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6`.
- Derivative: `lib/focus-templates/errors.ts`.
- License: Apache-2.0; [verbatim plugin-directory LICENSE](LICENSES/Apache-2.0-claude-plugins-official.txt).
- Changed: kept error-path analysis; removed invocation, output and praise; generalized project logging assumptions; scoped to introduced defects and replaced blanket criticality with impact-based severity. Attribution is metadata, not model-visible instructions. Modifications are covered by this repository's MIT license.

## Tests template

- Source: [upstream file](https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/pr-review-toolkit/agents/pr-test-analyzer.md), Anthropic, PBC.
- Pinned revision: `b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6`.
- Derivative: `lib/focus-templates/tests.ts`.
- License: Apache-2.0; [verbatim plugin-directory LICENSE](LICENSES/Apache-2.0-claude-plugins-official.txt).
- Changed: kept behavioral coverage and pragmatic gap analysis; removed invocation, praise, output and numeric ratings; generalized project rules; scoped to diff-introduced gaps and calibrated severity. Attribution is metadata, not model-visible instructions. Modifications are covered by this repository's MIT license.

## Types template

- Source: [upstream file](https://github.com/anthropics/claude-plugins-official/blob/b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6/plugins/pr-review-toolkit/agents/type-design-analyzer.md), Anthropic, PBC.
- Pinned revision: `b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6`.
- Derivative: `lib/focus-templates/types.ts`.
- License: Apache-2.0; [verbatim plugin-directory LICENSE](LICENSES/Apache-2.0-claude-plugins-official.txt).
- Changed: rewrote four rating axes as deficiency checks; removed per-type reports, strengths, invocation and output idioms; scoped to introduced defects and added pragmatic severity guidance. Attribution is metadata, not model-visible instructions. Modifications are covered by this repository's MIT license.

## Security template

- Source: [upstream file](https://github.com/anthropics/claude-code-security-review/blob/0c6a49f1fa56a1d472575da86a94dbc1edb78eda/claudecode/prompts.py), Copyright (c) 2025 Anthropic.
- Pinned revision: `0c6a49f1fa56a1d472575da86a94dbc1edb78eda`.
- Additional source: [exclusions and false-positive precedents](https://github.com/anthropics/claude-code-security-review/blob/0c6a49f1fa56a1d472575da86a94dbc1edb78eda/.claude/commands/security-review.md).
- Derivative: `lib/focus-templates/security.ts`.
- License: MIT; [verbatim repository LICENSE](LICENSES/MIT-anthropics-claude-code-security-review.txt).
- Changed: retained categories, methodology, exclusions and false-positive precedents; removed CI, schema, output and sub-task idioms; mapped severity and dropped LOW; qualified memory-safety exclusion for unsafe code and foreign interfaces. Attribution is metadata, not model-visible instructions. Modifications are covered by this repository's MIT license.

Both `plugins/code-review/LICENSE` and `plugins/pr-review-toolkit/LICENSE` at `b5b01ac4f889fec0c4c6bb89f27ca7c8574473f6` are byte-identical (`cmp`) to the existing Apache license above. Neither plugin has an upstream NOTICE or a filled-in copyright line; attribution follows the Docs precedent, Anthropic, PBC.

## Not used

- `anthropics/claude-code-action`'s `documentation-accuracy-reviewer` (MIT): no text copied.
- The pre-LICENSE `code-review` revision (`4ca561fb85`) in `anthropics/claude-plugins-official`: no text copied. Only the licensed pinned revision listed above is used.
- Anything from `anthropics/claude-code`, including its history (all rights reserved): no text copied.
- `claude-plugins-official/plugins/claude-security` (all rights reserved): not used.
