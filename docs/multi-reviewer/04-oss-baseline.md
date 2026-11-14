# OSS baseline for focused reviewers

Research for the multi-reviewer design (N focused reviewers → verify/aggregate → one review agent). Read 2026-11-09. Not legal advice.

**Legend.** **[V]** verified by reading the file/LICENSE/page at the SHA given. **[I]** inferred. Nothing was run. Licenses come from the actual LICENSE files, not GitHub metadata (metadata agreed in every case except where noted).

**This repo.** MIT, `LICENSE` lists two holders: Andrew Bird and Pritam Sharma [V]. Draft-comment tool: `add_draft_comment` with `severity` (blocking / should-fix / question / nit), `evidence`, `introduced`, `startLine`/`line` (`src/draft-tools.ts:51-70`) [V].

---

## 1. Inventory

### 1.1 Pinned SHAs

| Repo | SHA read (default branch HEAD) |
|---|---|
| anthropics/claude-plugins-official | `ea686bae367e20a4092b2fd4327ffd299bb60f24` |
| anthropics/claude-code-security-review | `0c6a49f1fa56a1d472575da86a94dbc1edb78eda` |
| anthropics/claude-code-action | `9eb012b6d0900c2b9eede65ee1758cec4d2973e9` |
| The-PR-Agent/pr-agent (was qodo-ai/pr-agent; redirects) | `7cd2a669cd4f3229f98c702e9319c3387aef5a88` |
| openai/codex | `e1cc96712f9ad4f5404fe821b9eba7ff29598816` |
| gemini-cli-extensions/code-review | `dd1a10d2c9d07b2ebade866590fdfa59cd8f9d04` |
| mattzcarey/shippie | `23e91d0c3ed12950c5de591e9e11d9b0c6dbf3f8` |
| kodustech/kodus-ai | `b759339a7435bd8c6064ff349cd7a65c1c5a033c` |
| anthropics/claude-code | `fd1f3c4263e54dc6128c25d6117f5c079ec9c38b` |

Before shipping, re-pin to the SHA actually copied and record it in each template header. HEADs moved during this research (e.g. claude-plugins-official pushed again today).

### 1.2 Reusable (permissive)

| Source | Path | License (file read) | What's in it | Reusable? | Attribution required |
|---|---|---|---|---|---|
| **claude-plugins-official / pr-review-toolkit** | `plugins/pr-review-toolkit/agents/{code-reviewer,comment-analyzer,pr-test-analyzer,silent-failure-hunter,type-design-analyzer,code-simplifier}.md` (last change `30202c7`, 2026-10-26) | Apache-2.0, `plugins/pr-review-toolkit/LICENSE`, byte-identical to repo-root `LICENSE` (`cmp`). **No copyright line filled in** (only the Appendix boilerplate `Copyright [yyyy] [name…]`). **No NOTICE file.** `plugin.json` author: "Anthropic" [V] | Six focus prompts (below). `code-reviewer`: CLAUDE.md compliance + bugs, confidence 0-100, report ≥80. `comment-analyzer`: accuracy / completeness / long-term value / misleading; sections Critical Issues, Improvement Opportunities, Recommended Removals, Positive Findings. `pr-test-analyzer`: behavioural coverage, criticality 1-10. `silent-failure-hunter`: catch blocks, fallbacks, logging. `type-design-analyzer`: 4 axes rated 1-10. `code-simplifier`: **edits code** (not a reviewer) [V] | **Yes**, with adaptation | Apache §4: (a) ship a copy of the license; (b) modified files carry prominent change notice; (c) keep upstream copyright/attribution notices (none present; see 1.5); (d) NOTICE: n/a, upstream has none [V] |
| **claude-plugins-official / code-review** | `plugins/code-review/commands/code-review.md` (current, from `c905cd8fec` 2026-10-26) | Apache-2.0 (`plugins/code-review/LICENSE`, identical to root) [V] | Orchestration prompt: eligibility check → CLAUDE.md file list → summary → 4 parallel finders (2× CLAUDE.md, 2× bug) → per-issue validation subagents → drop unvalidated → post. Includes a false-positive list [V] | **Ideas yes; text with care.** It's an orchestration script for Claude Code Task subagents, not a prompt we can drop in. Finder text and false-positive list are reusable | Same Apache §4. Provenance flag: `c905cd8fec` message says it was "brought in from anthropics/claude-code" (all-rights-reserved repo, §1.4). Anthropic is licensor in both, so the Apache grant is theirs to give, but a lawyer should note it (§5.3) |
| **claude-plugins-official / code-review (old)** | same path @ `4ca561fb85` (2025-11-20) | Apache-2.0 *as of today's tree*; the per-plugin LICENSE was added later (`aecd4c852f`, 2026-02-20, "Add Apache 2.0 LICENSE files to all internal plugins") [V] | 5 finders → per-issue **haiku scorer, 0-100 rubric (0/25/50/75/100), drop <80** → eligibility recheck → comment | Ideas yes. Pin the old SHA only if we want that rubric text verbatim; confirm the LICENSE applies to that revision (it was added after) [I on the retroactive reading] | Same |
| **claude-plugins-official / code-simplifier** | `plugins/code-simplifier/agents/code-simplifier.md` (`aecd4c8`) | Apache-2.0 [V] | Same body as the toolkit's; only the `description` examples differ (`diff`) [V] | Low value: it rewrites code, not review | Same |
| **anthropics/claude-code-security-review** | `claudecode/prompts.py`, `claudecode/findings_filter.py`, `claudecode/claude_api_client.py`, `.claude/commands/security-review.md`, `docs/*.md` (all `c19afa7`, 2025-08-06; repo last pushed 2026-02-11) | MIT, `LICENSE`: "Copyright (c) 2025 Anthropic" [V] | **Security focus**: category list (input validation, authn/z, crypto/secrets, injection/RCE, data exposure), 3-phase method, JSON schema, `confidence` 0.7/0.8/0.9 bands, hard-exclusion list (17 items) and 12 "precedents", per-finding **false-positive filter** with 1-10 confidence, drop <8; Python regex `HardExclusionRules` [V] | **Yes** (best-licensed, richest verification prior art) | MIT: keep copyright + permission notice "in all copies or substantial portions". Python code not needed; prompt text is |
| **anthropics/claude-code-action** | `.claude/agents/{code-quality,documentation-accuracy,performance,security-code,test-coverage}-reviewer.md`, `.claude/commands/review-pr.md` (all `11a01b7`, 2025-09-08) | MIT, `LICENSE`: "Copyright (c) 2025 Anthropic, PBC" [V] | Five focus agents + a fan-out/"post only what you also deem noteworthy" command (the aggregator is the parent agent re-judging) [V]. `documentation-accuracy-reviewer`: code docs, README, API docs | **Yes.** Note: these are the *repo's own dev agents*, not the action's runtime review prompt; the action has no dedicated review prompt in `src/create-prompt` (I found only trigger/event handling) [V for what I grepped, I that nothing else exists] | MIT notice as above |
| **openai/codex** | `codex-rs/prompts/templates/review/rubric.md` (`81de4f2`, 2026-07-21), embedded as `REVIEW_PROMPT` (`codex-rs/prompts/src/review_request.rs:9`) | Apache-2.0 root `LICENSE`. Root `NOTICE`: "Copyright 2025 OpenAI"; only third-party item is Ratatui, which does not pertain to the rubric [V] | A general-reviewer rubric: 8 "is it a bug" criteria, comment-writing rules, P0-P3 priority tags, `confidence_score` 0-1, JSON output, "overall correctness" verdict, dedupe by location + defect/remedy, repo-rule attribution [V] | **Yes**, best fit for the *general* focus's calibration text | Apache §4 + include "Copyright 2025 OpenAI" as the upstream attribution (root NOTICE line) [I that it's the right line to carry] |
| **The-PR-Agent/pr-agent** | `pr_agent/settings/pr_reviewer_prompts.toml` (`b20bb7d`, 2026-11-09), `code_suggestions/pr_code_suggestions_reflect_prompts.toml` (`d92a9b5`, 2026-10-25), `configuration.toml`, `algo/inline_comment_dedup.py` | **At `7cd2a66`: MIT**, `LICENSE`: "Copyright (c) 2026 The PR Agent" [V]. See license history below | Reviewer prompt (what to flag, comment style, untrusted-input guard), **self-reflection scorer** (0-10 per suggestion, explicit rules: score 0 for docstrings/unused imports/etc.), `suggestions_score_threshold`, cross-run dedupe fingerprints | **Yes at the MIT SHA**, but see lawyer flag §5.3 | MIT notice with that exact copyright line |
| **gemini-cli-extensions/code-review** | `skills/code-review-commons/SKILL.md`, `commands/{code-review,pr-code-review}.toml` (`dd1a10d`, 2026-03-10) | Apache-2.0 (`LICENSE`, verbatim standard text; I read the head, not the whole file) [V head] | Reviewer persona + hard constraints ("only comment on +/- lines", "never say verify/confirm/ensure"), 4-level severity CRITICAL/HIGH/MEDIUM/LOW, markdown output | Yes; good for the "don't say verify/ensure" constraint and severity rubric | Apache §4. No NOTICE seen [V `ls`] |
| **mattzcarey/shippie** | `src/agents/reviewer.ts` | MIT, "Copyright (c) 2023 Matt Carey" [V] | Own reviewer agent; I did **not** read the prompt | Possible; not evaluated [I] | MIT notice |

### 1.3 Copyleft / non-open: avoid

| Source | License [V] | Note |
|---|---|---|
| **kodustech/kodus-ai** | `license.md`: AGPL-3.0 for most code, plus `license_ee.md` "Kodus Enterprise Code License, Copyright (c) Kodus LLC" for enterprise dirs. GitHub metadata says `NOASSERTION` | Copyleft + proprietary carve-out. **Don't copy.** Reading for ideas is fine |
| **coderabbitai/ai-pr-reviewer** | repo not found (404) | CodeRabbit's product is proprietary; nothing reusable |
| **pr-agent, 2025-05-22 → 2026-05-20** | AGPL-3.0 (`70428eb`, "Update LICENSE": Apache→AGPL) | Anything copied from that window's revisions carries AGPL. See history |

**pr-agent license history [V via `gh api …/contents/LICENSE?ref=`, commit messages]:**
- 2023-07-05 `4b4d91d` initial: Apache-2.0
- 2025-05-22 `70428eb`: → AGPL-3.0
- 2026-05-20 `fdbcecc`: AGPL-3.0 → Apache-2.0
- 2026-07-09 `d7e94bc`: Apache-2.0 → **MIT** ("Copyright (c) 2026 The PR Agent")
- Repo moved from qodo-ai to The-PR-Agent; description: "This project is not the Qodo free tier." No NOTICE file at `7cd2a66` [V].
- To pin: any SHA ≥ `d7e94bc` (MIT). Don't pin anything between `70428eb` and `fdbcecc`.

### 1.4 NOT reusable (explicit)

- **anthropics/claude-code** (`fd1f3c4`): `LICENSE.md` = "© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service." [V]. At HEAD the repo has no `plugins/` dir [V], so the old copies of code-review / pr-review-toolkit there are history only. Don't copy from this repo or its history. (Same text exists under Apache in claude-plugins-official; copy from there, per §5.3.)
- **claude-plugins-official / plugins/claude-security**: `LICENSE` "Copyright (c) 2026 Anthropic, PBC. All rights reserved." Licence grants internal use "solely with Claude Code or other Anthropic products"; bars distribution and use "with, or to develop, any non-Anthropic product or service" [V, read in full]. Has its own `NOTICE.md` (CWE data). Don't read-and-paraphrase its prompts either; treat as off-limits. **Don't confuse with `security-guidance`** in the same repo, which is Apache-2.0 [V LICENSE head; contents not read].
- **Anthropic managed Code Review service**: proprietary. Only the public docs (§2) describe it. Docs text is Anthropic copyright; take ideas, not sentences.
- **`/code-review` bundled skill in Claude Code**: "its instructions are built into Claude Code, so there is no SKILL.md on disk" (docs). Proprietary; not available.
- Per-repo rule: `claude-plugins-official/README.md` says only "Please see each linked plugin for the relevant LICENSE file" [V]. So verify license **per plugin directory** every time; the repo root now has Apache-2.0 (`e9b54375`, 2026-05-28) but individual plugins can differ (claude-security does).

### 1.5 Reading of Apache terms for this use

- **Decided (owner, 2026-11-13):** attribute Apache prompt text to Anthropic, PBC with URL and pinned SHA; see [03 Open items](03-design.md#open-items).
- Prompts are expressive text, so treat as copyrightable "Work"; derivative = our adapted template.
- Apache §6: no trademark grant. Don't name focuses or UI "Claude Code Review", "Anthropic", "Codex". Naming sources in notices is allowed ("reasonable and customary use in describing the origin").
- MIT outbound + Apache inbound is the normal arrangement: the combined work stays MIT overall, the Apache-derived files keep Apache terms (§4 "additional or different license terms… for Your modifications… or for any such Derivative Works as a whole, provided Your use… otherwise complies"). **[I]**

---

## 2. Anthropic managed Code Review, as publicly documented

Sources (read 2026-11-09): https://code.claude.com/docs/en/code-review, `/code-review-customize`, `/code-review-pull-requests`, `/code-review-local`, and https://claude.com/resources/articles/code-review (research-preview announcement) [V]. **Ideas only; no text copied.**

Pipeline (four stages) [V]:
1. **Find**: several agents read the diff plus surrounding code, in parallel.
2. **Verify**: a step checks candidates against the code and drops false positives.
3. **Rank**: remaining findings deduplicated and ranked by severity.
4. **Post**: inline comments, summary, check run (never approve/block; check never "failure").

Other documented behaviour worth borrowing as ideas:
- **Default stance: correctness only** (bugs that break production), not formatting or missing tests; customization widens it. (Matches our "general" focus; our docs/comments focus is an opt-in widening.)
- **Review levels** Quick / Standard / Deep trade cost for thoroughness; org default, per-repo override. Users can't pick the model there. The announcement says "large or complex changes get more agents… trivial ones get a lightweight pass" and ~20 min average, $15-25 [V announcement]. **Idea for us:** per-focus effort already covers this; consider an auto "skip focus if diff doesn't touch X" gate (e.g. skip docs/comments when no comment/doc lines changed) [I].
- **Severity**: 🔴 Important (fix before merge), 🟡 Nit, 🟣 **Pre-existing** (not introduced by this PR). Maps to our Blocking / Should fix / Nit plus the existing `introduced:false` flag [I].
- **"Why this was flagged"**: collapsed reasoning + how it was verified. Maps to our `evidence` field [I].
- **REVIEW.md**: freeform repo-root file, read by *both* the finders and the verifiers, and consulted by the final step before settling severity and summary. Documented levers: redefine "Important", cap nit count, skip paths/finding classes, add team rules, "require evidence before posting a class of finding" (e.g. `file:line` citation). Includes other files via `@file` (max 8 files, 150 KB), subdirectory REVIEW.md. Read only from the protected base/default branch, **never from the PR's own changes** (prompt-injection defence) [V]. **Idea for us:** pass a repo's REVIEW.md/CLAUDE.md to every focus and to the verifier; never from the PR head. (Check whether the plugin already does something similar before building.)
- **Re-review scope**: later automatic reviews focus on what changed since the last review and post fewer nits/pre-existing; comment says how many were left out. Prior threads auto-resolved when judged fixed [V]. We already have re-review; confirm per-focus behaviour on re-review is defined [I].
- **Local `/code-review`**: effort level changes behaviour: `low` = only the most confident findings (fewer false positives); `medium`→`max` broadens coverage; `--max-findings n` (limit 32 where a findings tool is used) [V]. **Idea:** per-focus effort doubles as a precision/recall dial.
- Stats claimed (announcement): <1% of findings marked incorrect; 54% of PRs get substantive comments vs 16% before [V as claims; not independently verified].
- Not documented: model assignment per stage, agent count per level, verifier prompt, dedupe algorithm, severity-assignment prompt. Don't assume.

---

## 3. Baseline focus list

First release ships **two**: `general` and `docs/comments`. Rest are post-v1 candidates, ordered by fit.

| Focus | Base source (path) | License | Fit / adaptation | v1? |
|---|---|---|---|---|
| **general** | **Our current agent prompt** (keep) + calibration text from openai/codex `rubric.md` (what counts as a bug, comment style rules) + claude-plugins-official `code-review.md` high-signal/false-positive list | Apache-2.0 | Today's agent stays the base. Borrow only: (a) codex's 8 "should this be flagged" criteria and comment rules; (b) code-review's "do NOT flag" list (pre-existing, linter-catchable, pedantic). Low: it's additive to a prompt that already works [I] | **Yes** |
| **docs/comments** | **`pr-review-toolkit/agents/comment-analyzer.md`** (primary); `claude-code-action/.claude/agents/documentation-accuracy-reviewer.md` (secondary, for README/API-doc/changed-behaviour-vs-docs) | Apache-2.0; MIT | Best fit: comment-analyzer is already skeptical-of-comments, diff-agnostic, advisory-only. See adaptation below | **Yes** |
| security | `claude-code-security-review/claudecode/prompts.py` (+ `.claude/commands/security-review.md`) | MIT | Strong. Needs: drop JSON schema and CI framing; map HIGH/MEDIUM/LOW → Blocking/Should fix/(Nit or drop); keep exclusions list | later |
| error handling | `pr-review-toolkit/agents/silent-failure-hunter.md` | Apache-2.0 | Good. References "logError"/project logging helpers: genericize. Severity words → ours | later |
| tests | `pr-review-toolkit/agents/pr-test-analyzer.md` (+ `claude-code-action …/test-coverage-reviewer.md`) | Apache-2.0; MIT | Good. 1-10 criticality → severity map. Our existing "test files that lose assertions" flag overlaps (PRODUCT.md) | later |
| types | `pr-review-toolkit/agents/type-design-analyzer.md` | Apache-2.0 | Poor shape: outputs per-type ratings, not findings. Needs rewrite to emit only deficiencies | later/skip |
| performance / quality | `claude-code-action …/performance-reviewer.md`, `code-quality-reviewer.md` | MIT | Generic; high nit risk | later/skip |
| simplify | `code-simplifier.md` | Apache-2.0 | **Edits code**; not a review. Skip, or rewrite as "suggest only" | skip |

### 3.1 docs/comments: adaptation of `comment-analyzer.md` [I, estimated from reading the file and `src/draft-tools.ts`]

Keep (~50%): persona, mission, the five analysis lenses (accuracy, completeness, long-term value, misleading elements, improvements), "cross-reference every claim against code".

Change:
- **Frontmatter** (`name`/`model: inherit`/`color`): drop; template fields come from our template schema (instructions, harness/provider, model, effort).
- **"When to invoke" section**: delete (Claude Code auto-delegation text; meaningless here).
- **Output structure** (Summary / Critical / Improvement / Removals / Positive Findings): replace with calls to `add_draft_comment` (file, line/range, severity, body, `evidence` with file:line, `introduced`). Specifically:
  - Critical Issues (comment factually wrong) → **Should fix**; **Blocking** only if the wrong comment misstates a security/contract/public-API guarantee. Needs a rule in the prompt or the focus will over-escalate [I].
  - Improvement Opportunities → **Nit**.
  - Recommended Removals → **Nit**.
  - "Is the comment wrong or is the code wrong?" → **Question**. Add this: comment-analyzer assumes the code is right.
  - **Positive Findings** → drop (we post no praise; codex and Gemini rubrics also forbid it).
- **Scope**: restrict to comments/docs *added or modified in the diff*, plus existing comments *made false by the diff* (set `introduced:true`). Pre-existing rot → `introduced:false` or skip (Claude's managed service has a distinct "pre-existing" level).
- **Advisory-only line** ("Do not modify code or comments directly"): keep intent, restate as "use only draft-comment tools; never edit files".
- **Evidence rule**: add "every claim cites file:line you read" (REVIEW.md-style evidence guidance; our `evidence` field).
- **Volume**: add a nit cap and "skip comments that merely restate code unless the diff added them".
- Optionally merge documentation-accuracy-reviewer's README/API-doc checks as a second section, cut to what the diff touches (it asks for "request access", a Claude Code idiom; drop).

Net: about half rewritten, the analysis lenses kept verbatim or lightly edited. Because kept text is "substantial", treat the template as a Derivative Work with the full notice (§5).

### 3.2 general: where today's agent prompt differs

Today's review-agent prompt is plugin-owned (`src/agent.ts:47`, `src/preferences.ts` automatic-review prompt). Don't replace it. Add OSS-derived lines only where they close a gap: false-positive exclusion list, "only issues introduced by this change", comment style rules. Each borrowed block needs its own header attribution (§5.2).

---

## 4. Verification / aggregation prior art

| System | Pipeline | Score/threshold | Exposed settings [V unless noted] |
|---|---|---|---|
| **claude-plugins-official code-review (old, `4ca561fb85`)** | 5 sonnet finders → one haiku scorer per issue → filter → recheck eligibility | 0-100, rubric anchors 0/25/50/75/100 given "verbatim"; **drop <80** | None: threshold and rubric are prose in the command |
| **code-review (current)** | 2 CLAUDE.md finders + 2 opus bug finders → **one validation subagent per issue** (opus for bugs, sonnet for CLAUDE.md) → drop unvalidated | Binary validated/not; no number | `--comment` flag only. Dedupe is prose: "ONE comment per unique issue"; false-positive list inline |
| **`code-reviewer` agent** (toolkit) | Single agent self-scores | 0-100 (0-25 FP … 91-100 critical), **report ≥80**; groups Critical 90-100 / Important 80-89 | None |
| **claude-code-security-review** | Finder subtask → **one filter subtask per finding** with hard exclusions + precedents → drop low confidence. The Action also runs regex `HardExclusionRules` first, then per-finding Claude call | Finder: confidence 0-1, bands (<0.7 don't report). Filter: **1-10, drop <8**. Markdown files auto-excluded | Action inputs: `exclude-directories`, `false-positive-filtering-instructions` (path to custom text), `custom-security-scan-instructions`, `claudecode-timeout`, `claude-model`, `run-every-commit`, `findings-count`, `comment-pr`, `upload-results` (`action.yml`). Thresholds are not inputs: in prompt/code [I: didn't find a configurable constant] |
| **claude-code-action `review-pr.md`** | 5 focus subagents → **parent re-judges** ("post only feedback you also deem noteworthy") | None; "only noteworthy feedback" instructed per child | None. Closest to our "one agent talks to the user" shape |
| **pr-agent `/improve`** | Suggestions per chunk → **self-reflection call scores each 0-10** (0 = wrong; explicit down-scoring rules; reserve 8-10 for critical) | `suggestions_score_threshold` (default 1; docs warn >8 clips good ones), `score_on_reflection_failure=7` (set below the threshold to drop unvetted), `num_code_suggestions_per_chunk=3`, `focus_only_on_problems=true` | All in `configuration.toml` `[pr_code_suggestions]` (lines ~272-297) |
| **pr-agent `/review`** | Single prompt; `num_max_findings=3`; optional `require_score` (0-100 PR quality), `merge_recommendation`, `persistent_finding_state` | n/a | `[pr_reviewer]` ~175-218 |
| **pr-agent cross-run dedupe** | Fingerprint = SHA-256(file, anchor line, normalised body) **OR** SHA-256(file, line, normalised ```suggestion block); embedded as HTML-comment marker; skip if already posted | n/a | `algo/inline_comment_dedup.py`; default compares first 80 chars |
| **openai/codex rubric** | One reviewer; "deduplicate findings by changed location and defect/remedy"; `confidence_score` 0-1 and overall-confidence in schema | No threshold in prompt | n/a |
| **Managed Code Review** | find → verify → dedupe+rank → post | Not documented | Levels Quick/Standard/Deep; REVIEW.md (severity recalibration, nit cap, skip rules, evidence rules); "when reviews run" |

Takeaways for our aggregator [I]:
- **Two-stage filter is the consensus**: finder's own confidence, then an *independent* per-finding verifier with a rubric and hard-exclusion list. Our verifier = the same shape; the finder's confidence is a cheap pre-filter.
- **Threshold dials worth exposing**: verifier minimum (pr-agent: 0-10 threshold + failure default; security-review: 1-10 ≥8; code-review old: 0-100 ≥80). Pick one scale. Record the verifier's score on the comment so the reviewer sees why it was kept.
- **Dedupe needs two kinds**: *cross-focus, same run* (same file + overlapping line range + same defect: no OSS ships an algorithm; Anthropic says it exists but not how) and *cross-run* (pr-agent's fingerprint, directly reusable as an idea; our plugin already tracks comment states, so check overlap first).
- **Fail-safe on verifier failure**: pr-agent's `score_on_reflection_failure` is an explicit knob; decide keep-vs-drop deliberately.
- **Attribution tag** on a comment (which focus raised it) has no precedent in these tools. Only the managed service's "Why this was flagged" is nearby. Our own design.

---

## 5. Attribution plan

### 5.1 Files to add (repo root unless noted)

1. **`THIRD_PARTY_NOTICES.md`**: one entry per source actually used:
   - name, URL, pinned **SHA**, file path(s) copied, license name, copyright line (exact), which of our templates derive from it, one-line **statement of changes**.
   - Source list at time of writing (only those actually used in v1): `anthropics/claude-plugins-official` (comment-analyzer; and anything from code-review/openai if used), `anthropics/claude-code-action` (documentation-accuracy-reviewer, if used), `openai/codex` (rubric lines, if used).
2. **`LICENSES/`** directory with verbatim texts:
   - `Apache-2.0-claude-plugins-official.txt`: byte copy of `plugins/pr-review-toolkit/LICENSE` (identical to root). Same file can serve codex and Gemini (standard text) but keep the per-source copyright line in the notices file.
   - `MIT-anthropics-claude-code-action.txt`: "Copyright (c) 2025 Anthropic, PBC".
   - `MIT-anthropics-claude-code-security-review.txt`: "Copyright (c) 2025 Anthropic".
   - `MIT-pr-agent.txt`: "Copyright (c) 2026 The PR Agent" (only if used).
   - Add only the ones actually used.
3. **Template header comment**: each template file that derives from a source starts with:
   ```
   Derived from <owner/repo>/<path> @ <full SHA> (<SPDX>, © <holder>).
   Changed: <what: e.g. "removed invocation examples; replaced output format with draft-comment tool calls; added severity mapping; scoped to diff">.
   See THIRD_PARTY_NOTICES.md.
   ```
   For Apache sources this *is* the §4(b) "prominent notice that You changed the files". For MIT sources it's belt-and-braces for the notice requirement.
4. **Own copyright line**: add to `LICENSE`? Not needed. Modifications fall under the repo's MIT; optionally keep "Modifications © Andrew Bird and Pritam Sharma" in headers [I]; check contributors agree.
5. **README / docs/guide.md**: one line under a "Licenses" heading pointing to `THIRD_PARTY_NOTICES.md`. Optional UI "About" surface: not required by licenses.

### 5.2 Mechanics

- **Where templates live must survive the build.** `dist/` is gitignored and BB "builds the plugin from source when it installs or updates it" (`.gitignore` comment, [V]), so the repo files are the distribution; headers and notices ship with it. If templates later get inlined into a bundle, comments may be stripped; the root notices file still ships. [I]
- **User-visible templates**: if the template editor shows the instructions to the user, a header in the instruction text would be sent to the model. Keep attribution in a separate metadata field (e.g. `source`, `license`, `sourceSha`) plus the file header; strip headers from the prompt at send time. Don't leave "Anthropic"/"OpenAI" names in the model-visible text (trademark hygiene; also avoids a model repeating them in comments) [I].
- **Compose at send time**: if general = own prompt + borrowed lines, keep borrowed blocks in their own file(s) so the header attributes the file precisely, not the whole prompt.
- **Re-pin on every re-sync**: if we ever pull upstream updates, update SHA + changes in both header and notices; don't float a branch.
- **Copy from the permissively licensed location**: take code-review / pr-review-toolkit text from `claude-plugins-official` (Apache-2.0), never from `anthropics/claude-code`.

### 5.3 For a lawyer to look at (not advice)

1. **Provenance — decided (owner, 2026-11-13):** copy Apache prompt text only from pinned `anthropics/claude-plugins-official`; ignore copies elsewhere. See [03 Open items](03-design.md#open-items).
2. **Attribution — decided (owner, 2026-11-13):** Anthropic, PBC with URL and SHA. See [03 Open items](03-design.md#open-items).
3. **pr-agent relicensing.** Apache → AGPL (2025-05-22) → Apache (2026-05-20) → MIT (2026-07-09), under the new name "The PR Agent" (copyright line is an alias, not a legal entity I could verify). `pr_reviewer_prompts.toml` was modified inside the AGPL window [V: ≥1 commit in range]. Whether the current MIT grant covers contributions made under AGPL (CLA? contributor consent?) is not something I could determine. If we reuse pr-agent text, prefer short, original paraphrase of *ideas* (score rubric, down-score rules) or pin and accept the risk. I'd reuse its **ideas**, not verbatim text, unless someone checks the contributor/CLA position.
4. **Prompts as copyrightable text, and "substantial portions".** MIT/Apache turn on copying text. Heavy rewrite reduces the question; light edits keep the obligations. Treat every adapted template as a derivative either way.
5. **Anthropic docs / managed-service ideas.** Public docs are Anthropic's copyright; we're borrowing concepts (find→verify→rank; severity tiers; REVIEW.md idea). Concepts aren't copyrightable, but avoid copying wording, labels, and emoji conventions wholesale, and don't use the product names ("Claude Code Review", "REVIEW.md" as a *feature name* might be fine; the file name itself is generic, but confirm).
6. **Anthropic terms for model output/use** are separate from repo licenses. If a user runs these prompts on a different vendor's model, no issue from the repos' licenses; the all-rights-reserved plugins (claude-security) do restrict that and are excluded.
7. **Patent grant/termination** (Apache §3) applies to Apache-derived files; MIT has none. Fine for a plugin, but a lawyer may want to know the combined work has both.
8. **Co-author status.** Repo `LICENSE` lists Pritam Sharma as a copyright holder; headers on derived files should keep both or neither: confirm preference.

---

## 6. Recommendation (short)

- Ship v1 with `general` (own prompt, small additions) and `docs/comments` (comment-analyzer base, MIT/Apache attribution as in §5).
- Verifier: own prompt, shaped by security-review's filter (hard exclusions + evidence + 1-10 or 0-100 score) and code-review's "validate, then drop" per finding. Expose one threshold + keep/drop-on-failure.
- Prefer Apache/MIT sources by Anthropic and OpenAI; pr-agent for ideas only until the relicensing question is checked.
