# Multi-reviewer: UX prior art

Scope: how products present several AI reviewers/specialists, attribute output, and let users address one. Feeds the multi-agent design for Code Review Workspace.

Legend: **[E]** evidence (doc, post, thread, cited). **[O]** opinion/inference.
Method: web search + doc reads, 2026-11-09. Docs/threads only; I did not drive each product's UI. Thin spots flagged at the end.

> **Correction (2026-11-09, orchestrator):** this doc misses Anthropic's Claude Code Review (managed, ~$15–25/review) and the Apache-2.0 `code-review` plugin in anthropics/claude-plugins-official. Both fan out parallel focused agents, verify, dedupe, and post as ONE review voice; agents are not user-addressable. See `04-oss-baseline.md`. The owner chose this model: one review agent the user talks to, hidden focused reviewers, per-comment focus attribution. §§3 and 5 (addressing individual agents) are now out of scope.

## 0. Bottom line

- **[O]** Nobody in code review ships "several named specialists in one PR conversation" well. Review bots are mostly one bot per tool, with focus set by config (rules/paths), not by choosing a specialist.
- **[E]** The addressing patterns that work live in chat/agent products: `@`-mention (ChatGPT, Claude Code, Copilot, Linear, Slack), a mode/agent picker (Copilot, Cursor), and per-finding "ask" (Devin).
- **[E]** The dominant complaint is noise and duplication, not lack of specialists. Multiplying agents multiplies it unless merged/deduped.
- **[O]** Fit for us: one conversation per comment/review, an explicit addressee chip, attribution on every message, cross-agent opinion as an *action*, not a new thread.

## 1. Prior art

### 1.1 Code review products

| Product | Specialist chosen how | Attribution | Addressing | Threads | Complaints |
|---|---|---|---|---|---|
| **GitHub Copilot code review** | No specialists. One reviewer ("Copilot") requested in Reviewers sidebar. Focus via `.github/copilot-instructions.md`, path-scoped `.github/instructions/**/*.instructions.md`, `AGENTS.md`, `REVIEW.md`, skills, MCP **[E]** [1] | Posts as Copilot, "Comment" review, severity High/Medium/Low per comment. Comments carry footer attributions naming the skill/MCP source used **[E]** [1][2]. API now exposes explicit attribution fields **[E]** [3] | Cannot be chatted with in-thread: "Any replies… visible to other people but not to Copilot" **[E]** [1]. "Fix with Copilot" hands to the cloud agent; `@copilot` in PR comments reaches the coding agent only for write-access users **[E]** [1][4] | Native GitHub review threads | Lowest detection, quietest, in one 8-tool comparison **[E]** [5]. No reply loop is a gap **[O]** |
| **Copilot custom agents** (IDE/CLI/coding agent) | User-defined `.agent.md` in `.github/agents/`: name, description, tools, model, prompt. Picked from an agent dropdown, or `@mention` by name **[E]** [6][7] | Agent name in picker; same agent persists across a conversation **[E]** [7] | Dropdown at chat bottom (select), or `@name` | One chat; agent is a mode of it | Docs literally call the config "a persona" **[E]** [7]: avoid that word **[O]** |
| **CodeRabbit** | Single reviewer. Focus via `.coderabbit.yaml` `path_instructions`, `path_filters`; auto-reads `AGENTS.md`, `.cursorrules`, `CLAUDE.md` etc. **[E]** [8][9] | One bot handle `@coderabbitai`. Summary + walkthrough + inline comments | `@coderabbitai <command>` (`review`, `full review`, `pause`, `resolve`, `fix comments`, `summary`…) or free chat. One command per comment, must start the line **[E]** [8]. Chat in a review thread or PR comment **[E]** [10] | Inline threads + top-level; reviews every push by default | Noise: independent Lychee audit, 35% genuine, 21% nitpick, 15% useless **[E]** [11]. "8 commits → 8 reviews, each re-raising things" **[E]** [11]. HN: ignores "no nitpicks" instructions **[E]** [12] |
| **Cursor Bugbot** | Single reviewer. Rules: team → `.cursor/BUGBOT.md` (nested by path) → learned → manual. `bugbot run verbose=true` lists rules applied **[E]** [13] | One bot. Internally runs 8 parallel passes with shuffled diff order, majority-votes, validates, dedupes vs prior runs **[E]** [14] | `cursor review` / `bugbot run`; `@cursor remember …` teaches a rule inline **[E]** [13] | Inline PR comments; reads existing PR comments to avoid duplicates **[E]** [13] | Findings trickle across pushes instead of all at once; forum thread, acknowledged "known issue" **[E]** [15] |
| **Graphite Agent** | Single reviewer. Custom rules (prompt templates: security, accessibility, style), exclusions **[E]** [16] | Inline comments "just like your teammates'"; per-rule metrics (issues found, acceptance rate, up/down votes) **[E]** [16] | Comment feed tab, category filter; replies in thread | Native PR threads | Not mined; thin evidence |
| **Qodo / PR-Agent** | **Closest to "specialists", but as tools not people**: `/describe`, `/review`, `/improve`, `/ask`, `/implement`. Config per tool (`extra_instructions`) **[E]** [17][18] | Each tool's output is a distinct comment shape. `/improve` defaults to one table comment ("reduced noise… centralized tracking") rather than many inline comments **[E]** [19] | Slash command by intent; `/ask "…"` for chat; 👀 reaction acks receipt **[E]** [17] | Separate top-level comment per tool run | Qodo v1 being sunset **[E]** [17] (no UX data) |
| **Greptile** | Single reviewer. `.greptile/` rules with `scope` globs + `severity`; usage + "addressed rate" per rule **[E]** [20] | Bot comments; PR-level "confidence" score | `@greptile review`; Chat with PR in dashboard **[E]** [20][21] | Native threads | HN: "pure noise"; per-PR confidence score "big productivity loss" because it implies the PR is wrong **[E]** [22]. Also: highest detection, more false positives **[E]** [5] |
| **Sourcery** | Single reviewer, review rules. Labelled comments: `issue (bug_risk):`, `nitpick (performance):`, 🚨 for security **[E]** [23] | Category prefix in comment text; summary in PR description; reviewer's guide comment | `@sourcery-ai review/summary/guide/resolve/…`; reply in its thread to chat. Ignores other bots' comments **[E]** [23] | Native threads; re-review resolves addressed threads; auto re-reviews capped at 5 **[E]** [23] | One user ran 4 bots: Sourcery ≈90% of comments acted on vs Copilot ≈55% (self-reported) **[E]** [24] |
| **Devin Review** | Single reviewer; findings typed Bugs / Security / Flags(investigate) / Flags(note), each togglable for posting **[E]** [25] | Always posts as "Devin bot"; findings categorized **[E]** [25] | `/devin review`; "ask Devin directly from any comment, bug, or flag in the diff view"; quote a finding into chat **[E]** [25] | In-app chat + GitHub sync; later runs check duplicates/resolved **[E]** [25] | n/a |
| **Amazon Q Developer `/review`** | Detector libraries (SAST, secrets, IaC, quality, deployment risk, SCA) run together; user can't pick **[E]** [26] | Issues grouped by type in IDE panel | Chat `/review`; scope = diff / file / project | IDE panel, not threads | Not mined |
| **Ellipsis** | Not researched beyond a comparison blog **[E]** [5] | — | — | — | — |

Takeaways **[O]**: (a) focus is set by *instructions + scope*, which matches the planned "user-defined instructions"; (b) "category label inside the comment" (Sourcery, Devin, Copilot severity) is the established attribution-by-type pattern; (c) Graphite/Greptile per-rule effectiveness metrics are the only evidence-loop for pruning, and nobody does it per *specialist*.

### 1.2 Multiple review bots on one PR (the de-facto multi-reviewer product)

- **[E]** Users already run several. One developer: Copilot + Sourcery + GitHub Code Quality + Claude; 72 comments on one PR, "same suggestions repeated by three different reviewers", but each caught things others missed; consensus is a signal [24].
- **[E]** Artemis maintainers file "META: Limit number of automatically generated PR comments?": human comments are hard to find between Copilot, CodeRabbit, a Claude bot; bots repeat after every commit [27].
- **[E]** A third-party tool, Quorum, exists purely to cluster duplicate findings across Bugbot/Copilot/CodeRabbit/Devin and show reviewer agreement ("quorum ≥ 2") [28]. Strong signal the merged view is wanted.
- **[E]** Interaction effect: CodeRabbit treats existing PR comments as "hard facts" and suppresses duplicates, so ordering changed its measured quality [5]. Agents reading each other's output anchor on it **[O]**.

### 1.3 Agent-addressing products

| Product | Specialist chosen | Attribution | Addressing | One thread vs many | Complaints/limits |
|---|---|---|---|---|---|
| **Linear agents** | Workspace admin installs agents; agents are workspace "users" **[E]** [29] | Agent has a user page, shows as delegate; human stays assignee: "delegate issues, but not accountability" **[E]** [29][30] | Delegate (assign) or `@mention` in comment; can `@mention` for help. | Each mention/delegation creates an Agent Session with visible state (pending/active/awaitingInput/error/complete/stale), replies inside the issue's comment thread **[E]** [30][31] | Must ack within 10s or session shows unresponsive **[E]** [31] |
| **Slack bots / agents** | Channel binding, or `@` | Per-message name+avatar; or dedicated bot identity **[E]** [32] | `@mention`. Once mentioned, replies in that thread route to the same agent without re-mention ("thread tracking") **[E]** [32]. Smart routing variant: router picks agent unless "Mentioned only" is on **[E]** [33] | Thread per task | Default auto-responder still answers when user tags another agent: filed as a bug requesting suppression **[E]** [34]. Two bots reply at once and contradict: "working as designed" **[E]** [35]. Bot-to-bot loops need rate limits and `!mute` **[E]** [35] |
| **Claude Code subagents** | Auto-delegation by description, natural-language naming, `@`-mention typeahead ("guarantees the subagent runs"), or session-wide `--agent` **[E]** [36] | `name` + `color` per subagent; header shows `@agent` when session-wide **[E]** [36][37] | `@"code-reviewer (agent)" …`. Message still goes to the main agent which writes the subagent's task, "controls which subagent Claude invokes, not what prompt it receives" **[E]** [36] | Subagent runs in own context; main thread stays single. Running named subagents appear in the typeahead with status **[E]** [36] | Plugin subagents need scoped names to disambiguate **[E]** [36] |
| **ChatGPT GPT mentions** | Type `@`, pick a GPT | "Talking to X" chip above the composer, dismissed with ✕ **[E]** [38] | `@` keeps conversation context; next message goes to that GPT; only one GPT per message **[E]** [39][40]; web only, not mobile **[E]** [39] | One conversation, many responders | Switching GPT mid-chat blurs who said what unless the chip is visible **[O]** |
| **Cursor modes** | Mode picker (Agent/Ask/Plan/Debug) or Shift+Tab; custom mode = a pinned skill **[E]** [41] | Mode shown in picker | Modes, not agents; "switching modes starts a fresh context window" **[E]** [41] | New context per mode | Context reset on switch is a cost **[E]** [41] |
| **Devin** | See 1.1: ask from a finding | Bot label | Per-finding "ask", quote into chat | One chat per review | — |

Not found/verified: Windsurf Cascade multi-agent UX, Ellipsis internals, Amazon CodeGuru Reviewer specifics.

## 2. Naming

| Term | Implies | Used by | Verdict |
|---|---|---|---|
| **persona** | Character, voice, role-play | Copilot docs say "persona" [7] | Reject. Owner doesn't want characters. |
| **lens** | A view over the same thing; passive | none found | Nice for a *focus*; can't be asked a question or write a comment. Reject as the noun. |
| **reviewer** | A person who reviews | GitHub "Reviewers" (people and Copilot) [1] | Collides with the human reviewer, whom this product calls "the reviewer" throughout (PRODUCT.md). Reject. |
| **focus** | An attribute (what to look at) | CodeRabbit/Bugbot path instructions; "focus areas" | Good for the *setting* ("Focus: security"), not the thing you talk to. |
| **specialist** | Fixed expertise, hired in | Slack/agent products informally | Over-promises when instructions are user-defined; wordy. |
| **check** | Pass/fail gate | GitHub checks, CodeRabbit "pre-merge checks", Devin "CI check" [8][25] | Reject. Implies binary result, not a conversable thing. |
| **pass** | A run over the diff | Bugbot "passes" (internal) [14] | Describes a run, not an addressee. Reject. |
| **role** | Permission/access | RBAC, Slack roles | Reject. |
| **agent** | An LLM actor with instructions, tools, a name | Copilot "custom agents", Claude Code subagents, Linear agents, Cursor [6][29][36] | Best fit. BB already says "review agent", "Ask agent". |

**Recommendation [O]:** noun = **agent**; each one is named by its focus ("Security", "Docs"). The word "focus" labels the settings field. Keep the current agent as the default, called "Review agent" (or "General") so the multi-agent UI is purely additive for people who never opt in.
- Reasons: matches prior art vocabulary; matches BB's existing UI strings; carries no character; avoids the "reviewer" collision.
- Name = user-editable short label, 1–2 words, shown verbatim everywhere ("Security", not "Security agent") to keep chips short; "agent" appears only in headings and aria text.
- Open: if "agent" gets overloaded (Main thread is also an agent), consider "review agent" as the full term in prose only.

## 3. Patterns: "ask any agent from anywhere" without thread plumbing

| Pattern | Evidence | Pros | Cons |
|---|---|---|---|
| **A. `@`-mention in the composer** | ChatGPT, Claude Code, Copilot, Linear, Slack, CodeRabbit [36][39][29][32] | Familiar; works from any composer; one gesture; scales to N agents; typeahead can show status | Discoverability; mobile typing; mention vs. default ambiguity (Slack: default responder also answers [34]); `@` in a diff-review composer may collide with GitHub user mentions **[O]** |
| **B. One unified conversation, role tags per message** | Slack channel (name+avatar per message) [32]; ChatGPT chip [38] | Zero thread plumbing; reads chronologically | Becomes the "tangled web" at scale; contradictory simultaneous replies [35]; hard to scope to a comment/line **[O]** |
| **C. Per-comment "Ask ▾ → agent" menu** | Devin ("ask Devin from any comment, bug, or flag") [25]; Copilot "Fix with Copilot" [1] | Context implicit (the comment); explicit target; no syntax to learn; matches existing "Ask agent" buttons | Menu clutter on every card; only covers comment context, not free chat |
| **D. Router/orchestrator fans out** | Kylon smart routing [33]; Claude Code auto-delegation [36]; Bugbot 8-pass fan-out [14] | User doesn't choose; cheapest to learn | Violates "always clear which agent I'm asking"; unpredictable cost; mis-routes; user loses control **[O]**. Slack evidence: users want explicit tag to *suppress* the default [34] |
| **E. "Second opinion" action** | None found as a named pattern. Closest: quorum/consensus across bots [28][24] | Names the real intent ("what would Security think of this?"); one click; result attributed in place | New concept to teach; needs agent picker if >2 agents |

**[O] Recommended combination:** C + A on a single addressee chip, E as C's primary entry.
- Every composer (per-comment, selection ask, chat dock, Finish-review "Ask agent") shows **"Asking: Security ▾"**, like ChatGPT's "Talking to X" chip [38]. Defaults: comment composer → the comment's author agent; selection/dock → last-used or default agent. `@` in the box or the chip menu switches. No hidden routing.
- On any comment: **Ask ▾** → list of agents; with exactly two agents it collapses to "Ask Security". "Second opinion" = Ask pre-filled with "Do you agree with this comment?" addressed to a chosen *other* agent.
- The answer lands **in the same comment's discussion**, attributed, not a new thread. Agent B reads the thread, agent A isn't re-run.
- Skip D by default. Possible later as an explicit "Ask all" fan-out (Slack/Kylon evidence says people want it optional) **[O]**.

## 4. Pitfalls and mitigations

| Pitfall | Evidence | Mitigations seen |
|---|---|---|
| **Volume / duplicates across agents** | 72 comments on one PR [24]; Artemis META [27]; Lychee audit [11] | Cluster + show agreement (Quorum [28]); Bugbot dedupes vs prior runs and reads existing comments [13][14]; Qodo `/improve` table instead of inline [19]; Sourcery re-review resolves addressed threads, caps re-reviews at 5 [23]; CodeRabbit `pause`/`resume` [11]; Devin per-category posting toggles [25] |
| **Nitpick noise buries the real finding** | HN: "20 comments about variable naming and 1 about a race condition" [22]; HN thread on nitpicks [12] | Severity labels (Copilot [1], Sourcery [23], Graphite rules [16]); exclusions (Graphite [16]); majority voting + validator (Bugbot [14]); already ours: Blocking/Should fix/Question/Nit |
| **Conflicting advice** | Slack agents "reply at once and contradict… working as designed" [35] | Nothing good found. Closest: consolidator agent that dedupes, never edits severities [42]; independent fan-out then consolidate "prevents groupthink and surfaces disagreement" [42]. **[O]** surface disagreement, don't resolve it |
| **Anchoring / cross-contamination** | CodeRabbit read other bots' comments as hard facts; scores changed [5] | Run agents independently; share findings only on explicit ask **[O]** |
| **Cost / latency** | Bugbot counts every review and learning run toward usage [13]; Bugbot 8 passes [14]; re-review caps [23] | Opt-in per agent (planned); incremental reviews [13]; usage shown per agent **[O]**; rate limits for bot loops [35] |
| **Alert fatigue** | Maintainers disabling AI reviewers so human notifications aren't missed [43] | Single "your turn" signal (we have Needs You); batch not stream; pause/resume [11] |
| **Attribution confusion** | Slack: shared bot identity told apart only by name/avatar, dedicated identities are an upsell [32]; Greptile score read as a verdict on the PR [22] | Per-message name; typed category in text (Sourcery [23]); status visible per agent (Linear session states [31]); don't give an agent an overall score |
| **No feedback loop** | — | Graphite per-rule acceptance + votes [16]; Greptile "addressed rate" [20]; Bugbot learned rules [13]. Nobody scopes it per specialist **[O]** |
| **Un-addressable bot** | Copilot replies not seen by Copilot [1] | Every attributed comment must be askable (our requirement) |
| **Default responder fights explicit target** | Slack issue [34] | Exactly one addressee per message; chip shows it |

## 5. Takeaways for Code Review Workspace

1. **One conversation per comment (and one dock), never one per agent.** Agents are *participants*, not containers. In BB's side panel keep a single "Review agent" tab (rename later), not a tab per agent. This is the direct answer to "tangled web" **[O]**. Evidence for the shape: ChatGPT `@` keeps context in one thread [39]; Linear replies live in the issue thread [30]; Claude Code subagents don't fork the main thread [36].
2. **Attribute with text, not color alone.** DESIGN.md already reserves agent magenta for "anything the assistant wrote" and requires text/icons with color. Add the agent's label on every comment header and chat message ("Security · Should fix"), and a small per-agent glyph/monogram. Make the label the primary distinction; use at most subtle tint variants of the agent tone **[O]**. Consider the GitHub post: label is part of the body or severity footer so authors see it too (Copilot footers [1]); open decision.
3. **Addressee chip in every ask box, plus Ask ▾ on every comment.** "Asking: Security ▾", default = context's owner. "Second opinion" is a one-click Ask prefilled for a different agent. `@` switches the chip, doesn't route silently. Reply is attributed and lands in place **[O]** (patterns C+A+E, §3).
4. **Merge before you show.** Cluster same-line/same-issue findings across agents into one card with "also flagged by Docs", cap per-agent comment count, and run agents independently so they don't anchor on each other; cross-agent reading happens only on explicit ask. Reuse the existing filter chips with an **Agent** field in Comments, so "show me only Security" is one tap **[O]**; supported by Quorum's clustering [28] and the CodeRabbit anchoring finding [5].
5. **Keep it opt-in and small.** Start with the default agent only; "Add agent" from a template library (Security, Docs, Tests…) at the Overview or Settings; show per-agent cost and a per-agent acceptance rate (comments kept vs removed; we already record removal reasons) to prune **[O]**; cap concurrently active agents per review (suggest 3–4) **[O]**. Name the noun "agent", the setting "Focus" (§2).

## Sources

[1] https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-code-review
[2] https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/copilot-code-review
[3] https://github.blog/changelog/2026-11-06-copilot-code-review-api-management-and-review-overview-updates/
[4] https://github.blog/changelog/2025-08-05-copilot-coding-agent-improved-pull-request-review-experience/
[5] https://blog.bluedot.org/p/best-ai-code-review-tools-2025
[6] https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/use-copilot-agents/use-custom-agents
[7] https://github.com/github/awesome-copilot/blob/main/website/src/content/docs/learning-hub/building-custom-agents.md
[8] https://docs.coderabbit.ai/reference/review-commands
[9] https://docs.coderabbit.ai/knowledge-base/code-guidelines
[10] https://docs.coderabbit.ai/guide/chat
[11] CodeRabbit noise guide quoting the Lychee audit (surfaced via search; original post not opened): see search result "Fix the cause before the symptom"; underlying audit: Lychee project
[12] https://news.ycombinator.com/item?id=42451968
[13] https://cursor.com/docs/bugbot
[14] https://cursor.com/blog/building-bugbot
[15] https://forum.cursor.com/t/bugbot-doesnt-catch-all-issues-on-first-pass-multiple-review-cycles-needed/151367
[16] https://graphite.com/docs/ai-review-customization and https://graphite.com/docs/ai-review-comments
[17] https://docs.qodo.ai/v1/features/usage
[18] https://github.com/qodo-ai/pr-agent/blob/main/docs/docs/tools/review.md
[19] https://github.com/qodo-ai/pr-agent/blob/e9e7b22a/docs/docs/tools/improve.md
[20] https://www.greptile.com/docs/code-review/custom-standards
[21] https://www.greptile.com (Chat with PR; snippet only)
[22] https://news.ycombinator.com/item?id=46777079 and https://news.ycombinator.com/item?id=46766961
[23] https://docs.sourcery.ai/reviews/commands/ and https://docs.sourcery.ai/reviews/anatomy-of-a-review/
[24] https://dev.to/adam-knitli/i-let-four-ai-code-reviews-fight-over-my-prs-17je (self-reported, n=1)
[25] Devin Review docs (surfaced via search; page URL not captured; verify before citing externally)
[26] https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/code-reviews.html
[27] https://github.com/ls1intum/Artemis/issues/12576
[28] https://github.com/Wenjix/quorum
[29] https://linear.app/docs/agents-in-linear and https://linear.app/agents
[30] https://linear.app/developers/agents
[31] https://linear.app/developers/agent-interaction
[32] https://docs.ability.ai/faq/channels-and-messaging
[33] https://kylon.io/help/how-agents-decide-to-respond
[34] Feature request "default agent responds even when another agent is tagged" (Oz/Slack; surfaced via search, URL not captured)
[35] https://github.com/jeremylongshore/claude-code-slack-channel/blob/main/000-docs/multi-agent-channels.md
[36] https://code.claude.com/docs/en/sub-agents
[37] https://academy.claude.com/courses/introduction-to-subagents/creating-a-subagent
[38] https://www.makeuseof.com/how-to-use-gpt-mentions-in-chatgpt-conversation/
[39] https://help.openai.com/en/articles/8554407-gpts-in-chatgpt
[40] https://www.tomsguide.com/ai/chatgpt-just-got-a-big-upgrade-now-you-can-mention-custom-chatbots
[41] https://cursor.com/help/ai-features/agent and https://cursor.com/docs/agent/plan-mode
[42] Synthex multi-model review orchestration doc (surfaced via search; URL not captured)
[43] https://news.ycombinator.com/item?id=46349684

## Gaps / confidence

- **[E]-solid:** Copilot, CodeRabbit commands, Bugbot, Sourcery, Linear, Claude Code, ChatGPT mentions, Cursor modes (official docs).
- **[E]-weak:** Devin (snippet only), Greptile chat UI, Graphite thread UX, Amazon Q (no thread UX), Slack-agent items (third-party docs/issues).
- **Not covered:** Ellipsis detail, Windsurf, CodeGuru Reviewer, any product with several *user-defined* review specialists in one PR conversation. I found none, which is itself a finding but could be a search miss.
- Sources 11, 25, 34, 42 need URL recovery before external citation.
