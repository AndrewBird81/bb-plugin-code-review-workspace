# Codebase map: today's single-review-agent system

Plugin v1.12.1 (`package.json:3`). Read-only research for the multi-reviewer ("personas/lenses") design.

Legend: **[V]** verified by reading the code at the cited place. **[I]** inferred. Nothing was run; no test was executed.
Paths are repo-relative. "Review" = one row keyed by `targetKey` (`pr-…`, `ref-…`, `br-…`).

## 0. Vocabulary (code names ≠ product names)

- "Review agent" (UI/docs) = "assistant" (code: `assistant_threads`, `getAssistantThread`, `ASSISTANT_TITLE`). [V]
- "Guide writer" = "writer"/"generation worker" (`generations.worker_id`, `GUIDE_WORKER_TITLE`). Hidden, one-shot. [V]
- "Main thread" = the visible coding thread that receives Send (`ReviewLifecycle.mainThread`). Not a review agent. [V]
- "Fixer" = a visible thread the plugin spawns to fix comments (`src/fix-handoff.ts:145`); recorded in `implementers`/`sends`. Not a review agent. [V]
- "Suggester" = hidden Suggest-instructions worker (`src/learning.ts:291`, `SUGGESTER_TITLE`), review key `NO_REVIEW`. [V]
- `AgentMessage`/`agent_threads`/`agent_messages` = legacy (pre-BB-thread chat) transcript, superseded on first assistant spawn (`src/agent.ts:280-286`). [V]

---

## 1. Review agent lifecycle

### 1.1 Threads per review today

| Thread | Count | Visibility | Created | Recorded in | Role lookup |
|---|---|---|---|---|---|
| Review agent (assistant) | **max 1 live** per review | hidden | lazily, on first message (`src/agent.ts:248` `spawnConversation`) | `assistant_threads` PK `target_key` (`src/store.ts:742`) | `assistantReview(tx, threadId)` = `listAssistantThreads().find` (`src/draft-comments.ts:32`) |
| Guide writer | 1 live per generation; old ones archived | hidden | `beginGuide` (`src/generate.ts:155`, spawn ~`:210`) | `generations.worker_id` (`setGenerationWorker`) | `tx.generationOf(workerId)` |
| Main thread | 0–1 (+`implementers` history) | visible, user's | not spawned by plugin (bound via `bb review` / `setMainThread`, `src/loop.ts:543`) | `ReviewLifecycle.mainThread`, `implementers`, `sends[].threadId` | n/a |
| Fixer ("Fix in a new thread") | 0–n, one per click | visible | `startFixThread` (`src/fix-handoff.ts:145`) | `sends`/`implementers` | n/a |
| Deep dive | **no thread**; a message to the one review agent | — | `digDeeper` (`src/deep-dive.ts:56`) → `messageAssistant` | `ReviewLifecycle.deepDive` | — |
| Suggester | 1 global at a time | hidden | `src/learning.ts:317` | kv `former-workers` after finish | `spawnsTitled` while in flight |

All other turns (re-review check, discussions, relayed asks, Dig deeper, open-PR) go to the single assistant thread via `messageAssistant`. [V]

### 1.2 Spawn path

- Entry points: `startConversation` (`src/agent.ts:179`; RPC `startConversation` `src/assistant-rpc.ts:16`) and `messageAssistant` (`:422`) which starts one if none exists. Automatic review: `startAutomaticReview` (`:305`) after guide ready (`src/generate.ts` end of `beginGuide`). [V]
- Serialisation: `starts` WeakMap keyed by `targetKey` (`src/agent.ts:168-170`); a second caller awaits the first (`:181`). `startConversation` throws if `getAssistantThread(targetKey)` already set (`:187`). **One start at a time per review; hard-fails on a second.** [V]
- Pre-spawn: `machineUnavailable` (`:249`), `agentPlacement` (`src/machines.ts`): default `{projectId, environment:{type:"project-default"}}`; with custom `hostId` → personal project + `{type:"host", hostId, workspace:{type:"personal"}}`. [V]
- `bb.sdk.threads.spawn` args (`src/agent.ts:259-272`): `input` = [visible first message, optional agent-only `context`, optional agent-only legacy transcript], `title`, `visibility:"hidden"`, `pluginMetadata:{targetKey}` (unread; comment says only a 0.6.0 rollback reads it), `...spawnExecution(agent)`. Always via `spawnAgent` (adds an agent-only `crw:<nonce>` mark, `src/asking.ts:158`). [V]
- Title: `"Review agent: " + [id, name?, targetKey]` (`assistantTitle`, `src/agent.ts:207`). `ASSISTANT_TITLE` prefix (`:21`) is a role key **only while the spawn is in flight** (`spawnsTitled`); after that role is by recorded id. [V]
- `spawningFor(bb, title, targetKey, run)` (`src/thread-review.ts:12`) registers an in-flight `{title, targetKey}` so `agents.configure` (called by BB on the new thread's first session, possibly before `spawn` returns the id) can identify it. [V]
- Then `store.setAssistantThread(targetKey, worker.id)` (`:273`), `realtime.publish("review:<key>")` and `"reviews"` (`:276-277`). [V]

### 1.3 Provider / model / permission choice

- Agent choice type `AgentChoice` = `{hostId?, providerId, model, reasoningLevel, serviceTier?}` (`src/agent.ts:33`). [V]
- Source order for a new conversation (`getConversation`, `src/agent.ts:127-162`): `preferences.assistantAgent` (global Settings "Review agent", Custom) → else `bb.sdk.projects.defaultExecutionOptions({projectId})` → else null (UI forces picking). Dock lets user override via `ProviderModelPicker` (`components/AgentDock.tsx:~190`). [V]
- Permission mode: only if the global `assistantAgent.permissionMode` exists **and** same `providerId` as the chosen agent (`src/agent.ts:271`); otherwise unset → BB resolves provider/project default. Review agent therefore usually runs at the project's mode (can have a shell). [V]
- Guide writer permission is separate: `guideWriterMode` (`src/generate.ts:104`) = lowest of accept-edits/auto. [V]
- After spawn, model/effort change per message in BB's chat (docs/guide.md:269). Effort bump per message: `raisedLevel` / `messageAssistant({effort})` (`src/agent.ts:406,422`); only Dig deeper uses it (`DEEP_DIVE_EFFORT="high"`, `src/deep-dive.ts:15`). [V]

### 1.4 Tracking, archive, delete

- Storage: `assistant_threads(target_key PK, thread_id, created_at)` (`src/store.ts:742`). API: `get/set/clear/listAssistantThreads` (`src/store.ts:647-650`, impl `:1522-1538`). `setAssistantThread` is an upsert on `target_key` (replaces silently). [V]
- Live check: `getConversation` calls `threads.get`; if archived/deleted/missing → `recordFormerWorker(…,"assistant")` (kv `former-workers`, `src/former-workers.ts:20`, cap 500), `clearAssistantThread`, `endAssistantWaits`, calls `waitsEnded` listener (→ `sync.evaluate`) (`src/agent.ts:142-158`). Next message spawns fresh. [V]
- `newConversation` (`:457`): record both assistant + legacy thread as former workers, clear rows + legacy messages, archive threads. RPC also `clearAsks` + `endAssistantWaits` (`src/assistant-rpc.ts:28-37`). [V]
- Review delete (`src/reviews-rpc.ts:288`): refuses while generating or `isAssistantAnswering`; collects `assistant`, legacy, writers; `tx.deleteReview`; then `threads.stop` + `threads.delete` each, recording leftovers as former workers (`:302-323`). [V]
- Review archive (`archiveReview`, `:262`) only sets `userArchivedAt`; **does not archive threads** (docs/guide.md:269: archived PRs keep their conversation). [V]
- Merge (`mergeReview`, `src/store.ts:1109-1111`): moves `from`'s assistant row to `into` **iff `into` has none**; else it is "kept apart, named in mergedFrom" (the row stays under `from`). `retitleAssistant` renames thread (`src/merge.ts:63`). [V] How a second agent would merge is undefined today [I].
- Idle refresh: `refreshAssistants` (`:518`) stops all idle assistant runtimes so next message re-runs `agents.configure` with fresh instructions/tools. Triggered by: settings changes of `assistantInstructions|runRepoChecks|unattendedAuthors|preExistingFindings|agentCoverage|testWeakening|reviewAgentActs` (`src/settings-rpc.ts:30-35`), guide ready (`src/generate.ts:317`), and bump of `ASSISTANT_TOOLS` (`src/server-modules.ts:104`, check in `server.ts:384`). [V]
- Startup: unfinished asks cleared (`server.ts:158` `openStore`); `settleOutlivedWaits` (`:246`) every 60 s. [V]

---

## 2. Agent context, tools, output

### 2.1 How it gets context

- **Instructions** via `bb.agents.configure` (`server.ts:90` registers a sync wrapper; real fn `server.ts:358`). Role from `configured.threadRole(thread)` (`src/configure-view.ts:65`): recorded assistant id → `"assistant"`; recorded writer → `"writer"`; in-flight title prefix; else null. Only threads whose `origin.pluginId` is this plugin (or former Guided Review) get review tools; **others get only the `code-review-workspace` skill** if `reviewCommandInThreads` (`server.ts:359-361`). [V]
- Assistant config returned: `tools = ASSISTANT_TOOL_NAMES (+ ASSISTANT_WRITE_TOOL_NAMES if knobs.reviewAgentActs)`, `skills: []` (**no skill file for the review agent; it's all in the `instructions` string**), `instructions = assistantInstructions(...)` (`server.ts:~370`, `src/agent.ts:43`). [V]
- `assistantInstructions` (`src/agent.ts:43-70`, `fitInstructions` `:76`): fixed rules (target key, untrusted-data rule, `ACTS_WHEN_ASKED` vs `DRAFTS_ONLY` `:28-30`, repo-checks rule, requirements rule) + knob-driven check lines (`preExistingFindings`, `agentCoverage`, `testWeakening`) + **one global** `preferences.assistantInstructions` (≤2000 chars, `lib/review-preferences.ts:55`) + the guide (intent, chapter titles/risk, hotspots, requirements) fenced `<guide>`. **Hard cap 4000 chars** (`INSTRUCTIONS_LIMIT` `src/agent.ts:23`; BB truncates at 4096); preferences cut first to leave `GUIDE_RESERVE=800` for the guide core; check lines dropped whole from the end. A lens prompt would compete for this budget. [V]
- Instructions are rebuilt from `configured.review()/guide()/preferences()` — an in-memory snapshot refreshed by the store queue (`src/configure-view.ts:112-125`) because `configure` is sync. `KEEPS_VIEW`/`CHANGES_GUIDES` sets list which Store methods invalidate it (`:13-30`); a new Store method that changes anything `configure` reads must not be in `KEEPS_VIEW`. [V]
- **First message + per-turn context**: user text visible; `context` string agent-only (e.g. `discussionMessage` `src/discussions.ts:33`, `deepDiveMessage` `src/deep-dive.ts`, `verificationContext` `src/verification.ts:33`, relay note `src/relays.ts:160`, `reviewContextNote` for `bb review --context`). Each message also gets `takePrNote` appended once (`src/agent.ts:427`). [V]
- **Automatic review prompt** = `preferences.automaticReview` (global; default in `lib/review-preferences.ts:57+`), sent by `startAutomaticReview`; gated by `knobs.runAutomaticReview`, trust (`mayRunUnattended`), PR state. [V]
- **Tools** (registered once, shared by every assistant thread; scope is resolved per call from the **calling `threadId`**):
  - Read: `read_review_patch`, `list_review_files` (`src/patch-tools.ts:23,67`), `list_feedback`, `read_changes_since_review`, `read_pr_context`, `read_file`, `assess_feedback`, `draft_thread_reply` (`src/feedback-tools.ts:34-183`), `list_draft_comments`, `report_deep_dive`.
  - Draft write: `add_draft_comment`, `edit_draft_comment`, `delete_draft_comment`, `set_review_summary`, `reply_in_discussion` (`src/draft-tools.ts:56-123`).
  - GitHub/act (only when `reviewAgentActs`, each re-checks): `submit_review`, `post_reply`, `resolve_thread`, `github_pr`, `open_pr` (`src/review-agent-tools.ts:422-615`), `send_now` (`src/loop.ts:682`), `push` (`src/push.ts:523`). Lists: `ASSISTANT_TOOL_NAMES`/`ASSISTANT_WRITE_TOOL_NAMES` (`src/server-modules.ts:96,102`).
  - Writer-only: `generate_review_guide` (`src/guide-tool.ts:12`), `WRITER_TOOL_NAMES` (`:94`).
  - Every tool maps thread→review with `assistantReview(tx, threadId)` (`src/draft-tools.ts:31`, `src/feedback-tools.ts:25,118`, `src/review-agent-tools.ts:104`, `src/loop.ts:695`, `src/push.ts:532`). `recordAgentReads` also gates on it (`src/agent-reads.ts:19`). [V]
  - Who's asking per turn: `classify(threadId)` (`src/asking.ts:270` `createClassifier`) reads BB events for that thread; marks stored in kv `asking-marks` keyed by nonce with `threadId`; thread-generic. [V]
  - Post form previews: kv `post-preview:<threadId>` and `post-confirmed:<threadId>`, one open preview **per agent thread** (`src/review-agent-tools.ts:57,81-83`). [V]
- **Skills**: `skills/code-review-workspace/SKILL.md` (for *the user's other threads*, `bb review …`), `skills/code-review-workspace-generate/SKILL.md` (guide writer only). Ids passed in tests via `agentSkillIds` (`src/registrations.test.ts`). Review agent gets none. [V]
- Trust: PR text fenced `untrusted()` (`src/untrusted.ts`); instruction files read from PR base. [V per docs; not traced in code]

### 2.2 How it writes drafts / summary / verdict

- All writes are tool calls into the plugin's local draft (nothing to GitHub). `assistantDraft` wrapper (`src/draft-tools.ts:29`): resolves review from thread, checks `mergedAway`, runs `act` inside `store.exclusive`, then `realtime.publish("draft:<key>", {})`. [V]
- Comment add: `addComment` (`src/draft-comments.ts:114`): requires a free location, `code` must match the diff line, sets `author:"agent"`, appends to `draft.unseen`, logs `noteDiscussionChange(...,"added")`. **Refuses if the location already has any draft comment** (`:122-123`). Dig deeper links it via `noteDeepDiveComment`. [V]
- Edit/delete (`editComment :143`): agent's own comments free; the reviewer's only inside a turn where `ask` is open on that location (`asked()`, `src/asks.ts:53`) or `inChat && knobs.reviewAgentActs` (`reviewersToo`, `src/draft-tools.ts:20`). [V]
- Summary/verdict: `writeSummary` (`src/draft-summary.ts:13`) → `updateSummary` sets `body`, `bodyAuthor:"agent"`, `suggestedVerdict`, `unchecked`, `written:{verdict, comments:commentsKey}`. **One summary, one `suggestedVerdict`, one `unchecked[]` per review**; second writer overwrites. `APPROVE` suggestion refused by `approveRefused` (`src/feedback-view.ts`). Reviewer-written summary is protected unless an ask is open on SUMMARY. [V]
- Verdict itself is the reviewer's (`Draft.verdict`, `verdictChosen`). [V]
- Removal/edit learning: `agent_comment_changes` (per `target_key,file,line,side`) and `agent_comment_outcomes` (per `repo`) → `learningStats`, Suggest instructions → writes into the single `assistantInstructions` (`src/learning.ts`). No agent id in either. [V]

### 2.3 Data model: draft comment (`src/draft.ts:47`)

```
DraftComment {
  file, line, side: "LEFT"|"RIGHT"|"LOCAL", startLine?, startSide?, chapterId?,
  author?: "agent"          // only value; absent = reviewer. NO agent/persona id.
  severity?: blocking|should-fix|question|nit,
  body, evidence?, introduced?: false,
  id?: "c<n>", state?: open|sent|resolved|dismissed, sendN?, claim?, editedBy?: "agent"
}
```

- Identity key = `(file,line,side)`; "a draft holds at most one comment per location" (`src/draft.ts:111`). `sameLocation` used everywhere; `upsertDraftComment` keyed by it. [V]
- Storage: `drafts(target_key PK, verdict, body, comments TEXT JSON array, meta TEXT)` (`src/store.ts:722,771`); `meta` carries `bodyAuthor, suggestedVerdict, written, verdictChosen, unchecked, unseen`. Plus `draft_comment_revisions(target_key,file,line,side PK)` (patch hash/code) for staleness. [V]
- `Draft.bodyAuthor?: "agent"` and `Discussion*`/`ReplyDraft.author: "reviewer"|"agent"` — same two-valued author everywhere (`src/draft.ts:138-160`, `reply_drafts.author`). [V]
- `author` surfaces: badge/edge styling `components/comments/look.tsx:16-28,109`, `InlineDraft.tsx:154,199,210,238,361`, `SummaryCard.tsx:55`, `lib/comments.ts:243,290,331,393`, `ReplyBox.tsx:139`, `FinishView.tsx:521`, `DraftProvider.tsx:500`. Constant "Agent" label + sparkle + `--ansi-13` tone (`DESIGN.md:49`). [V]
- GitHub payload drops `author`, `evidence`, `id` etc. (`toGithubReviewPayload`, `src/draft.ts`); severity becomes a label via `postedBody`. A persona label would need to be added there deliberately. [V]

---

## 3. Ask / chat surfaces

All route to the **one** assistant thread via `messageAssistant(bb, store, targetKey, text, context, marking)` (`src/agent.ts:422`).

| Surface | UI | RPC / path | Target thread |
|---|---|---|---|
| Ask agent dock (BB side-panel tab "Review agent") | `components/AgentDock.tsx:60` (`ThreadChat` from SDK once `threadId`), tab reg `components/PanelTabs.tsx:16,59`, `app.tsx:85` | `getConversation`, `startConversation`, `newConversation`, `noteInserted` (`src/rpc-contract.ts:362-380`) | `getAssistantThread(targetKey)` |
| Selection-to-ask | `components/shell/SelectionBar.tsx:96` → `useWorkspace().askAgent(context, quote)` → `setInjection` (`components/ReviewWorkspace.tsx:1266`) → `openTab("agent")` (`:380`) → dock consumes `injection` once (`AgentDock.tsx` effect ~`:118-142`): before thread exists, becomes chip/quote in first-message box; after, `composer.insert(text)` into BB's composer after `noteInserted` RPC (so the classifier knows the text is plugin-written). Nothing is auto-sent. | — | active dock's thread |
| Line/summary discussion ("Ask agent" on comment, Reply) | `components/InlineDraft.tsx:425,455`, `DraftProvider.tsx:435` `askAgent`, summary `requestSummary :443` | RPC `askAgent` (`src/rpc-contract.ts:270`) → `askAgent` (`src/discussions.ts:64`) | assistant thread; message text `On file:lines: …` + agent-only context (comment, lines, history; `discussionMessage :33`) |
| Dig deeper | chapter card button | RPC `digDeeper` (`:275`) → `src/deep-dive.ts:56` | assistant thread, `effort:"high"` |
| Re-review feedback check | Check again / automatic | `src/verification.ts:81` | assistant thread |
| Per-GitHub-thread Reply / draft reply | `components/LineThreads.tsx`, `comments/ReplyBox.tsx` | `draft_thread_reply` tool writes `reply_drafts` | n/a (reviewer posts) |
| Other BB threads | `bb review ask <review> <text>` (`src/relays.ts:150`); or `bb thread tell <agentThreadId>` using `bb review list --json` `agentThreadId` (`src/list-command.ts`) | `messageAssistant(kind:"relay")` | assistant thread |
| Thread-page "Review" tab | `components/ThreadSurfaces.tsx:141` `ReviewPane` | `getConversation` + `AgentDock bare` | assistant thread |
| Open PR / etc. | `src/open-pr.ts:112` | `messageAssistant` | assistant thread |

- **Discussion model**: `discussion_entries(target_key,file,line,side, author, kind, body, start_line, previous, created_at)` + `discussion_waits(target_key,file,line,side PK)` (`src/store.ts:744-750`). **One discussion per location**, summary at `SUMMARY_AT` (`src/draft.ts:119`). `Discussion.waiting` flips when the agent hasn't answered. [V] No "thread id" per comment other than location.
- **Ask lifecycle**: `Ask = {threadId|null, state: sending|queued|running, queuedMessageId?, at}` (`src/store.ts:446`) stored in `ReviewLifecycle.summaryAsk`, `commentAsks[]` (per location), `deepDive.ask` (`:89,94,98`). Opens the reviewer's own comment to edit **in that turn only** (`asked()` checks `ask.threadId === calling threadId`, `src/asks.ts:53`). Only **one deep dive per review** (`src/deep-dive.ts:66-67`). `ASK_LIFETIME` 30 min. Cleared on turn end by `settleAs` (`src/assistant-events.ts:16`), on cancel/dispatch events, on startup, and by `settleOutlivedWaits`. [V]
- **Reply routing back to UI**: the agent never replies "into the UI" except via tools: `reply_in_discussion` → `replyInDiscussion` (`src/draft-comments.ts`) → `draft:<key>` realtime → `DraftProvider` `useRealtime` reload (`components/DraftProvider.tsx:~190`) → `discussions` state. Chat text itself appears only in BB's `ThreadChat`. Status glyph: `agentStatus` (BB thread row → `lib/review-indicator.ts:69`) via `src/agent-status.ts`; `readAgent` RPC marks read (`lib/use-agent-read.ts`). Channels: `review:<key>`, `reviews`, `draft:<key>`, `conversation:<key>`, `feedback:<key>`, `preferences`. [V]
- **How a question targets a thread today**: it doesn't — there's no selector; everything resolves `targetKey → getAssistantThread`. The only "thread id as target" paths: `askAgent`/`digDeeper` store `ask.threadId` snapshot (`await tx.getAssistantThread(targetKey)` at `src/discussions.ts:72`, `src/deep-dive.ts:69`), `noteInserted` checks `getAssistantThread === threadId` (`src/assistant-rpc.ts:24`), and `bb thread tell <agentThreadId>` (external). [V]
- Mention-style "ask security to chime in on docs persona's comment": no mechanism (no cross-agent messaging). Agent-to-agent send from the plugin's own threads is explicitly classified "unattended" (`relayed()` `src/asking.ts:273`; `bb review ask` refuses own agents `src/relays.ts:152`). [V]

---

## 4. Settings, knobs, preferences

- **Global only** (one row): `review_preferences(id=1 CHECK, value JSON, revision, knobs JSON)` (`src/store.ts:740,787`). Revision-checked optimistic save (`savePreferences` `src/settings-rpc.ts:23`; "changed" error on stale rev). `value` stays strictly parseable by old releases; `knobs` in own column (`src/settings-knobs.test.ts`). [V]
- **Per-review settings**: essentially none. Per-review state lives in `ReviewLifecycle` (JSON in `review_lifecycle.state`): `name`, `snoozedAt`, `pinnedAt`, `userArchivedAt`, `skippedRun`, `approvedHead`, etc. There is **no per-review knob override or per-review agent choice**; per-review override of agent exists only as "which agent starts the first message" (dock picker, not stored). [V]
- Schemas: `preferencesSchema` (`src/preferences.ts:59`, `.strict()`), `knobsSchema` (`:39`, `.strict()`), types `lib/review-preferences.ts` (`ReviewPreferences`, `defaultPreferences :57`), `lib/knobs.ts` (`Knobs`, `defaultKnobs :26`, `KNOB_RANGES`). Reader `readPreferences` (`src/preferences.ts:115`) validates each field independently → bad field takes its default; unknown fields dropped. [V]
- Agent-related prefs: `assistantAgent: AgentExecution|null` (provider/model/effort/permission/hostId; `null` = project defaults), `assistantInstructions` (≤2000), `automaticReview` (prompt, ≤12000), `verificationPrompt`, `guideAgent`, `guideInstructions`, `runRepoChecks`, `unattendedAuthors`. [V]
- UI: `components/ReviewSettings.tsx` (agent pickers `:354-369`, Assistant instructions textarea `:367`, learning `:369`), knob switches `components/SettingsKnobs.tsx:23` `KNOB_CONTROLS` (`section`, `label`, `description`, `enabledWhen`), shared context `lib/settings.tsx`. [V]
- **Adding a boolean knob** (derived from the above [I] with spot checks [V]): (1) `lib/knobs.ts` `Knobs` + `defaultKnobs`; (2) `src/preferences.ts` `knobsSchema` (strict, so required); (3) `components/SettingsKnobs.tsx` `KNOB_CONTROLS` entry; (4) if it affects agent instructions/tools, add to the refresh list in `src/settings-rpc.ts:30-31` and maybe bump `ASSISTANT_TOOLS`; (5) docs `docs/guide.md` "Feature switches" (`:667`); (6) tests: `src/settings-knobs.test.ts`, `src/settings-off.test.ts` + `components/settings-off*.test*`.
- **"Off by default" today**: **no knob defaults to false**; `defaultKnobs` is all `true` (`lib/knobs.ts:26-41`; header comment "Every toggle on"). Non-knob opt-ins that are off: `runRepoChecks:false`, `trackTeamRequests:false`, `pushChecks:"off"`, `autoStartRepos:[]`, `assistantAgent:null`, plus plugin auto-update (opt-in, `PRODUCT.md`). [V] Convention: a new feature ships as a knob **on** (the plugin's rule: "Settings has a switch for each feature that can get in the way… each on by default", `PRODUCT.md`); an off-by-default knob would be new precedent and must be read right when old saved rows lack it.
- **Persistence quirk**: `savedKnobs` (`src/preferences.ts:99`) omits `SAVED_WHEN_CHANGED` knobs (`reviewAgentActs, reviewChangesLine, trackOwnPrs, approveGuardTestsPace, approveGuardDocsPace`) while at default, so a later default change reaches everyone who never touched it (`:93-96`). Choose deliberately for any new knob whose default may change. [V]
- Rollback compat: new `knobs` keys are unknown to older releases but `readKnobs`/`unknownKnobs` preserve them (`src/preferences.ts:83,104`); `savePreferences` merges `{...before.knobs, ...preferences.knobs}` (`src/settings-rpc.ts:26`). [V]
- Structured lists in prefs (e.g. a personas array) have precedent only in `autoStartRepos` (validated array with cap `AUTO_START_REPOS_LIMIT`, `src/preferences.ts:74`) and `filter_views` table (`src/store.ts:791`, saved views with own RPCs `listFilterViews/saveFilterView/deleteFilterView`, `src/settings-rpc.ts:64-74`). No template/"preset" concept exists. [V]

---

## 5. Storage / schema / migrations

- Two backends, one `Store` interface (`src/store.ts:513`): SQLite via `bb.storage.migrate(db, SQLITE_MIGRATIONS)` (`src/store.ts:715-805`) and optional Postgres via `PG_MIGRATIONS` (`src/db/pg-migrations.ts:14`, `migratePg :101`). **Append-only, index = id, SHA-256 of statement text recorded; editing a shipped statement throws.** Lists must grow together "in the same commit" (`src/db/pg-migrations.ts:1-3`; `src/db/pg-migrations.test.ts` asserts parity [I]). Postgres types: BIGINT for ms, `COLLATE "C"` for keys. KV (`bb.storage.kv`) used for ledgers (`asking-marks`, `asking-inserts`, `former-workers`, `post-preview:*`, `post-confirmed:*`, completion pending, comment counter), never migrated. [V]
- Tables (SQLite, `src/store.ts`): `reviews, patches, guides, drafts, file_views, agent_threads, agent_messages, generations, draft_comment_revisions, review_lifecycle(state JSON), review_preferences, reviewer_notes, assistant_threads, review_context, discussion_entries, discussion_waits, review_snapshots, feedback_threads, feedback_fetches, assessment_items, assessment_runs, reply_drafts, discovery_ignores, guide_backups, agent_comment_changes, agent_comment_outcomes, filter_views, chapter_reads` (+ `plugin_updates` SQLite-only, `src/plugin-updates.ts`). [V]
- Pattern for new per-review fields: add to `ReviewLifecycle` (JSON) — **no migration needed** (1.12.0 changelog: "what else it adds is kept with the review's other lifecycle fields"). New table only when relational (e.g. `chapter_reads` was 1.12.0's one migration). [V]
- **New per-review table checklist**: add to `REVIEW_TABLES` (`src/store.ts:1783`; used by delete/storage-copy) and to `mergeReview` (`:1095-1150`, comment says so) and to `src/storage-copy.ts` [I] and `scripts/store-reads.ts`/`store-dump.ts` [I]. Also `deleteReview`'s thread cleanup (`src/reviews-rpc.ts:302`) if it holds thread ids.
- Versioned data tests: `src/data-1.7.0.test.ts` and `src/data-1.8.1.test.ts` load frozen `data.sql` fixtures (`src/fixtures/1.7.0/`, `1.8.1/`: `data.sql, keys.json, payloads.json, reads.json`) into SQLite and assert every Store read + GitHub payload equals what the old release produced. Fixtures created by running `scripts/fixture-1.7.0.ts` / `fixture-1.8.0.ts write` in an old tag's checkout. Reverse (old code reads new data): `docs/fixture-1.8.0.md`, `docs/fixture-1.9.0.md` (manual, `scripts/fixture-1.9.0.ts`). `docs/development.md:48` ("Backend tests on Postgres") explains. **Rule**: any change to what the store keeps must keep 1.8.1/1.7.0 data loading and old release able to read new data on rollback (changelog states rollback behaviour per release). [V]
- Current storage of "who is the review agent": single row per review (PK). To hold N agents you need either a new table (+ both migration lists, `REVIEW_TABLES`, `mergeReview`, `storage-copy`, fixtures/reads dumps) or a JSON field in `ReviewLifecycle`. `listAssistantThreads()` is also what `configure-view` snapshots (`src/configure-view.ts:76,108,131`). [V]

---

## 6. Re-review, whose-turn, Needs You — single-agent assumptions

- **Feedback check (`startVerification`, `src/verification.ts:81`)** → `messageAssistant` to the one assistant; state is review-level scalars: `verifyingSince, verifyingHead, verifyingMessageId, verifyingFixes` (`src/store.ts:74-78`, plus `assessment`, `preparedAt`). `endCheck` on `thread.idle`/`failed` of **the** assistant (`src/assistant-events.ts:16-47`); `queuedCheck` matches `entry.threadId` via `assistantReview`. With two agents, "the turn ended" fires per agent; nothing counts completions. [V]
- Check outputs: `assess_feedback` → `assessment_items/runs` keyed `(target_key, head_sha, item_id)` — no agent dimension (`src/store.ts:758-763`). [V]
- **Whose turn**: `lib/turn.ts` computes from review data (`signals`, `assessment`, `heldTurn`, `readyToApprove`, `verifyingSince`, push/fix state). Agent-turn states (`waitsOn:"agent"`) refer to the **main thread/fixer** only (`lib/review-status.ts:8-26`, `waitsOnThreadId` = fixer/pusher thread `src/public-contract.ts:28`), **never to the review agent**. "Idle review agent" doesn't hold a review. [V] So persona agents don't change `reviews.v1.status` unless you add states.
- **Auto flows**: `sync.actions.prepare/checkPushes/checkFixes/autoStart` (`server.ts:~175-195`) → `startVerification`/`rerunReview`; `onPrepared` and `onAssistantWaitsEnded` → `sync.evaluate` (`server.ts:~167-168`). `rerunReview` rebuild → guide → `refreshAssistants([targetKey])` → `startAutomaticReview` (`src/generate.ts:~315-330`). Guide rebuild-with-new-commits sends "New commits … re-check your draft comments" to the one thread if it authored any draft comment (`src/agent.ts:316-326`: `comments.some(c => c.author === "agent")` — **persona-blind**). [V]
- **Needs You alerts** (`src/completion-notifications.ts`): keyed by `targetKey` + `generationId` ("guide ready/failed") and turn signals; none keyed by agent. `knobs.alertGuides`/`alertTurns`. A persona finishing would produce no alert today; adding one means a new signal kind [I]. [V for keying]
- **Row/page indicator**: `agentStatus` per review = one thread (`src/reviews-rpc.ts:60-70` `Map<targetKey, threadId>`; `reviewIndicator` `lib/review-indicator.ts:69`; `ReviewItem.agentStatus` singular). [V]
- **Learning/Suggest**: one `assistantInstructions` target. [V]
- Trust skip / "Run review" button: `skippedRun {run:"guide"|"review"|"check"}` is one record per review (`src/agent.ts:385`); `runSkipped` (`src/turn-rpc.ts:59`) re-fires the single automatic review. [V]
- Finish review "Read 14 of 16 files" and "agent coverage": `agentReads {head, files[]}` single list per review (`src/agent-reads.ts:19`), `unchecked` single list (`Draft.unchecked`). [V]
- Activity log: `activity: ActivityEntry[]` with `asking, from, fromTitle` — no actor-agent field (`src/review-agent-tools.ts:122`). [V]

---

## 7. Hard single-agent assumptions (the important list)

### 7.1 Storage / identity

1. `assistant_threads.target_key` is the **PK** → one thread per review (`src/store.ts:742`). `setAssistantThread` upserts (`:1525`). [V]
2. `assistantReview(tx, threadId)` returns just `targetKey`; no role/lens (`src/draft-comments.ts:32`). Used by ≥10 call sites (draft-tools, feedback-tools, patch-tools via `toolThreadReview`, review-agent-tools, loop send_now `:695`, push `:532`, assistant-events ×4, agent-status, agent-reads, discussions, own-pr `:55`, feature-review `:341`, loop `:74,552`, thread-review). [V]
3. `getAssistantThread(targetKey)`: single-valued; call sites: `src/agent.ts` (many), `server.ts:253`, `src/discussions.ts:72`, `src/deep-dive.ts:69`, `src/assistant-rpc.ts:24`, `src/agent-status.ts:37`, `src/reviews-rpc.ts:108,302`, `src/review-command.ts:219`, `src/merge.ts:29,52`, `src/feature-review.ts:716` (`agentPrNote`), `src/generate.ts:327`. [V]
4. `listAssistantThreads()` consumers treat result as 1:1 key↔thread: `configure-view.ts:76,108,131`, `reviews-rpc.ts:63,331`, `thread-surfaces.ts:27`, `agent.ts:519` (`refreshAssistants`). [V]
5. `ReviewLifecycle.agentPrNote` (one pending note, `takePrNote` taken by whichever message/tool answer reaches the agent first) (`src/store.ts:229`, `src/agent.ts:226,242`). Must be per-agent or all agents miss it. [V]
6. `agentReads` / `Draft.unchecked` / `Draft.suggestedVerdict` / `bodyAuthor` / `written` / `Draft.unseen`: single agent-attributed fields. [V]
7. `DraftComment.author?: "agent"` and `DiscussionEntry.author`, `ReplyDraft.author`: two-valued; no which-agent. [V]
8. One comment per `(file,line,side)` and one discussion per location (`addComment` refusal `src/draft-comments.ts:122`; `draft_comment_revisions`/`discussion_waits` PKs; `agent_comment_changes` key). Two lenses commenting the same line collide. [V]
9. `former-workers` kv roles `"assistant"|"writer"|"suggester"` (`src/former-workers.ts:14`). [V]

### 7.2 Lifecycle / threading

10. `startConversation` throws "already has a conversation" (`src/agent.ts:187`); `starts` map keyed by `targetKey` (`:168`). [V]
11. `getConversation` returns a single `{threadId, defaults, machine, legacy}` (`src/agent.ts:127`; RPC `src/rpc-contract.ts:362`). Frontend consumers: `AgentDock.tsx:94`, `ReviewWorkspace.tsx:395` (opens "the" thread beside the review for old BB), `ThreadSurfaces.tsx:152`. [V]
12. `messageAssistant` resolves the thread from `targetKey` — the signature has no persona parameter; used by discussions, deep-dive, verification, relays, open-pr, automatic review. [V]
13. `newConversation` archives "the" assistant and clears legacy messages + asks (`src/agent.ts:457`, `assistant-rpc.ts:28`). [V]
14. `spawnConversation` title `"Review agent: …"` prefix + `threadRole` prefix match (`src/configure-view.ts:133-136`): a second role must either reuse the prefix (role "assistant" can't distinguish) or add one + a role + a branch in `configure` (`server.ts:358-378`). Only in-flight; after that role comes from recorded rows → a new table/column must be exposed to `configure-view` snapshot (and added to `KEEPS_VIEW` appropriately). [V]
15. `agents.configure` returns instructions built from one global `assistantInstructions` and the same tool list for every assistant (`server.ts:372-378`). [V]
16. `refreshAssistants` restarts **all** idle assistants on any relevant setting change. [V]
17. `ASSISTANT_TOOLS` version constant triggers a one-time restart for all (`src/server-modules.ts:104`, `server.ts:384`). [V]
18. Review delete / merge / archive logic enumerates `getAssistantThread` + `getAgentThread` + writers (`src/reviews-rpc.ts:302`); merge adopts one (`src/store.ts:1109`). [V]
19. `retitleAssistant` renames one (`src/agent.ts:213`; called by `feature-review.ts:642`, `merge.ts:63`). [V]
20. `isAssistantAnswering` / `assistantMayAnswer` single-thread: used to block delete (`reviews-rpc.ts:293`), check feedback (`turn-rpc.ts:113`), reports (`reports.ts:348`), `settleOutlivedWaits` (`server.ts:258`). [V]

### 7.3 Turn/ask state (scalars on `ReviewLifecycle`)

21. `summaryAsk`, `commentAsks[]`, `deepDive` (one chapter at a time, `src/deep-dive.ts:66`), `verifyingSince/Head/MessageId/Fixes` — all assume the one thread; `ask.threadId` is a snapshot of it. [V]
22. `settleAs` on `thread.idle`/`failed` iterates asks where `ask.threadId === thread.id` (OK for N) but `endCheck` runs for "the review's check" whenever **any** thread resolving via `assistantReview` idles with no queued messages (`src/assistant-events.ts:36-39`) — would end the feedback check when a *different* agent idles [I from code reading]. [V for code]
23. `discussionsWaitingOn(threadId)` marks **all** waiting discussions of the review as settled when one thread's turn ends (`src/discussions.ts:94-111`; `store.stopWaiting(key)` clears every location). With N agents, one agent's idle would clear another's waiting discussion. [V]
24. `endAssistantWaits` (`src/agent.ts:473`) same: clears all waits + the check. [V]
25. `Ask.state` flows: `askAgent` snapshot `threadId: await tx.getAssistantThread(targetKey)` (`src/discussions.ts:72`). [V]

### 7.4 Tools / permissions / classification

26. `classify(threadId)` thread-generic (OK), but `fromOwnAgent` / `ownThread` = "recorded assistant OR former worker" (`server.ts:309` `ownThread`) — a second agent class must be added or its messages to other agents are treated as "relayed from the reviewer" (`createClassifier` `relayed()`: `own(sender) === false ? "relayed" : "unattended"`, `src/asking.ts:273`). [V]
27. `bb review` subcommands `ownReview` guard (`server.ts` `run`; `toolThreadReview`) restrict own agents to their review; `comment/summary` CLI mutate the same single draft with `author:"agent"`. [V]
28. Post-form preview per `threadId` (OK for N) but `submit_review` writes the single review summary/verdict. [V]
29. `reply_in_discussion`, `add_draft_comment` have no way to name a persona; tools infer from thread. [V]
30. `send_now`/`push`/`open_pr` write tools exist on every assistant thread when `reviewAgentActs` (`ASSISTANT_WRITE_TOOL_NAMES`) — a read-only lens would need a different tool list in `configure`. [V]

### 7.5 Surfaces / UI

31. Tab "Review agent" is one fixed `REVIEW_TABS.agent` (`components/PanelTabs.tsx:16`, `app.tsx:85`), `AgentDock` keyed by `targetKey`, `injection` is a single slot (`ReviewWorkspace.tsx:207`, `handledInjections` map by `targetKey` in `AgentDock.tsx`), `firstDrafts` per `targetKey`. [V]
32. `panel.open("agent")`/`openPanel("agent")`/`onOpenPanel("agent")` call sites (`FinishView.tsx:323,359`, `ChapterIntro.tsx:111`, `DraftProvider.tsx:762`, `ReviewWorkspace.tsx:1268,1533`) have no persona argument. [V]
33. `ReviewItem.agentStatus` singular on All reviews rows/overlay (`reviewIndicator`); `useAgentRead(targetKey, unread)`; `readAgent` RPC marks one thread read. [V]
34. `ReviewPane` in thread page uses `AgentDock bare` and `ThreadChat` for one thread (`components/ThreadSurfaces.tsx:141-190`). [V]
35. Copy: "Review agent", "the agent", "Agent" everywhere (comment cards, summary label, `Waiting for agent`, `Agent’s reply`, `New from agent`, Finish "agent coverage"), and `DESIGN.md` uses one `agent` tone (bright magenta) for "anything the assistant wrote or does". [V]
36. Settings: one "Review agent" section (`ReviewSettings.tsx:354-369`), one Assistant instructions field, one Suggest/learning loop. [V]
37. Docs/guide and PRODUCT.md describe "the review agent" as one; `skills/code-review-workspace/SKILL.md` tells other threads `bb review ask <review>` reaches "the review's agent" (`src/relays.ts:19`, usage text). [V]

### 7.6 Public API / external

38. `bb review list --json` exposes `agentThreadId` (singular) (`src/list-command.ts:50`). `reviews.v1.status` doesn't expose the review agent (only main/fix threads) so it's unaffected (`docs/plugin-api.md`, "Within v1, fields may be added, never removed"). [V]
39. `src/registrations.test.ts` inline snapshot lists every RPC method/tool/subcommand: any new RPC/tool/subcommand requires `npx vitest run src/registrations.test.ts -u` (`docs/development.md`). [V]
40. `src/agent-sends.test.ts:19` forbids new `threads.send/spawn/fork/retry` outside `src/asking.ts` (+ named exceptions) — new agent spawns must use `spawnAgent`/`sendToAgent`. [V]

---

## 8. Test infrastructure

- Runner: Vitest 3 projects (`vitest.config.ts`): `backend` (`src/**` + `scripts/**` tests; node; setup `src/real-gh.test-support.ts` makes the real `gh` fail, `src/test-backend.test-support.ts` swaps Store to Postgres if `CRW_TEST_PG_URL`), `frontend` (`components|lib|hooks/**/*.test.{ts,tsx}`; jsdom; 15 s timeout), `e2e` (`e2e/**`). `npm test` = `vitest run`. `npm run check` = test + `tsc --noEmit` + eslint + `bb plugin types --check` + `bb plugin build` (`package.json:63-68`). Node 24. [V]
- Fake host: `createFakePluginHost` from `@get-bb/plugin-sdk/testing` (SDK 0.6.104) provides `bb` + `harness` (`harness.inspection.sdk.callsTo("threads.spawn")`, `.registrations`, `harness.behavior.callRpc`). Override `sdk.threads/projects/...` per test (example `src/agent.test.ts:28-38`). Real temp SQLite per host. Plugin start helper `startPlugin(bb)` (`src/plugin-store.test-support.ts`); `testStore(bb)`, `testSql(bb)` (`src/test-store.test-support.ts`). [V]
- Agent chat simulator: `src/agent-chat.test-support.ts` `agentChat(threadId)` fakes `threads.send/spawn/events.list`, queue/dispatch/cancel, ancestors, marks → used to test `classify` and queue events. `MARK_PART` matcher. Tool helpers `toolText`, `toolFailed`, `spawnPrompt` (`src/fake-host.test-support.ts`). Folder/env fakes `src/env-diff.test-support.ts`. Fuzz store-parity `src/store-backends.test.ts`, `src/fuzz-gen.test-support.ts`. [V]
- Key test files by area: lifecycle `src/agent.test.ts`, `src/asking.test.ts`, `src/asks.test.ts`, `src/thread-surfaces.test.ts`, `src/archive-delete.test.ts`, `src/review-lifecycle.test.ts`, tools `src/draft.test.ts`/`draft-comments.test.ts`/`review-agent-tools.test.ts`, `src/deep-dive.test.ts`, `src/discussions.test.ts`, events `src/relays.test.ts`, configure `src/registrations.test.ts`, `src/settings-knobs.test.ts`, `src/settings-off.test.ts`; UI `components/AgentDock.test.tsx`, `main-thread.test.tsx`, `thread-surfaces.test.tsx`, `agent-read.test.tsx`, `draft-review.test.tsx`, `inline-comments.test.tsx`, `settings-off*.test*`. [V file names; contents not all read]
- Frontend tests render with RTL + mocked `useRpc`; `components/settings-off.test-support.tsx` stubs `getConversation` etc. (`:39`). [V]
- e2e: `e2e/*.test.ts`, opt-in via env `BB_E2E_URL` (isolated BB on loopback only; `e2e/loopback.ts`), `BB_E2E_THREAD`, `BB_E2E_AGENT_THREAD`, `BB_ACTIVITY_E2E_URL`; RPC intercepted into SDK test host with real SQLite, GitHub/agents stubbed (`docs/development.md` e2e sections). Skipped without env. [V]
- Postgres: `scripts/test-postgres.sh` (Docker `postgres:18`); `src/db/pg*.test.ts` skip without URL. [V]
- Architecture/lint guard tests worth knowing: `scripts/async-audit.test.ts`, `scripts/store-reads.test.ts`, `src/server-bundle.test.ts`, `src/engines.test.ts`, `src/guide.test.ts`. [I from names]

---

## 9. Seams that look extensible (no design)

- `AgentChoice`/`spawnExecution`/`agentPlacement` already take an explicit agent → per-persona provider/model/host is a parameter away. [V]
- `configure` branches by role from `configure-view.threadRole`; adding a role (e.g. `"lens"`) with its own tool list/instructions is local to `server.ts:358-378` + `configure-view.ts`. [V]
- Tools resolve context from `threadId`, so a thread→(review, persona) lookup is the only change needed in the ~10 `assistantReview` call sites (centralised helper `src/draft-comments.ts:32`). [V]
- `ReviewLifecycle` is a JSON blob → new per-review fields need no migration; `filter_views` + RPC trio is a template for a user-managed list with its own table. [V]
- `Marking`/ledger (`asking-marks`) is keyed by `threadId`, already N-thread-safe; `post-preview:<threadId>` too. [V]
- `Ask.threadId`, `Discussion` location keys, and `DiscussionEntry.author` are the places where "which agent" could be added additively (JSON/optional). [I]
- `injection` + `REVIEW_TABS` + `openTab` is the only path from selection → chat; it carries `{context, quote, nonce}` and could carry a target. [I]
- UI authorship rendering is concentrated in `components/comments/look.tsx`, `lib/comments.ts` (`speaker`, `STATE_LABEL`), `InlineDraft.tsx`, `SummaryCard.tsx`. [V]
- `knobs` with `enabledWhen`, `SAVED_WHEN_CHANGED` and `readKnobs` give a safe opt-in/rollback path. [V]
- `src/store.ts` `mergeReview` + `REVIEW_TABLES` + `storage-copy` are the places any new relational table must be taught (checklist-style). [V]

## 10. Open facts I could not confirm

- Exact SDK semantics for multiple tabs with the same `id` or dynamic tab registration in `app.slots.experimental_tab` (only static `agent`/`main` tabs and one thread-context `review` tab are used, `app.tsx:85-96`). [not checked in SDK]
- Whether BB truncates `instructions` per-thread at 4096 or globally (code assumes 4096, `src/agent.ts:22`). [I]
- Behaviour of `pluginMetadata` for role identification in BB itself (plugin treats it as unread). [I]
- Exact current numbers/names in `src/registrations.test.ts` snapshot (not read in full).
