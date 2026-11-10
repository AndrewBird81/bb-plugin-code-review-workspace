# Review of 03-design.md

Skeptical review. Read-only; nothing run except grep/read and `git show v1.9.0:…`.
Legend: **[V]** opened and checked (file:line or SDK type). **[I]** inferred.
SDK = `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts` (0.6.104). It is readable; 03's "no readable `.d.ts`" is wrong.

## 0. Verdict

- Architecture A (hidden thread per focus, review agent merges) is right. Keep it.
- **Two safety gaps** the design misses: focus threads have a shell and the `bb review` CLI, and the lowest permission mode isn't read-only (§3.1).
- Phase 1 as written can't ship alone: Stop, plugin restart and new-head handling are deferred to Phase 3 (§7).
- "Off = today exactly" breaks on the review agent's tool list (§3.9).
- One 03 claim is wrong: per-thread token usage **is** exposed (§1b).

## 1. The four unchecked assumptions

### a. `threads.spawn` args: **holds, one caveat**
- [V] `ThreadSpawnArgs = Omit<CreateThreadRequest, …> & ({input}|{prompt})` (SDK:18556-18567).
- [V] `CreateThreadRequest` has `providerId`, `model`, `reasoningLevel`, `serviceTier`, `permissionMode` (`accept-edits|auto|full`), `parentThreadId`, `lifecycleOwnerThreadId`, `environment` (reuse / host …), `visibility: hidden|visible`, `title`, `pluginMetadata` (SDK:12504-12709).
- [V] Caveat: the server drops `providerId`/`model` with no `executionInputSources` provenance (SDK:25590-25593). `spawnExecution` already sets `explicit` for each (`src/preferences.ts:154-168`). Focus spawns must go through it, not hand-build fields.
- [V] Caveat: `guideWriterMode` picks the mode from the **project default's** provider (`src/generate.ts:104-113`). For a per-focus override, pass `known: { providerId: override }`, or the mode can be one the override's provider doesn't support.
- [V] `pluginMetadata` exists. Use it to tag focus threads (run id, focus id), so a restart sweep finds orphans without title matching.

### b. Per-thread usage: **03 is wrong, it's exposed**
- [V] Thread events `thread/tokenUsage/updated` carry `{ last, total }` input/output/cached/reasoning tokens (SDK:2840-2865).
- [V] `thread/contextWindowUsage/updated` carries an optional `cost: { amount, currency }` (SDK:2866-2871).
- [V] Readable through `bb.sdk.threads.events.list({ threadId, types: [...] })` (SDK:18705-18712, 18789-18792).
- [I] Whether every provider emits them, and whether cost is filled in, is unknown. Treat tokens as best-effort and cost as optional.
- Consequence: §7 #10 ("words only") can become real numbers per run. Read the archived focus thread's last `total` at run end.

### c. Merge turn can't use act tools: **holds**
- [V] `messageAssistant` → `sendToAgent` marks the message with the caller's kind (`src/agent.ts:422-440`). `kind: "automatic"` maps to `unattended` (`src/asking.ts:32`).
- [V] Every act tool refuses `unattended`: `submit_review` only marks a suggested verdict (`src/review-agent-tools.ts:438`), and the others refuse (`:493, :528, :558, :631`, `src/loop.ts:704`, `src/push.ts:538`).
- [V] Draft tools work when unattended (`src/draft-tools.ts:25`). That's what the merge needs.
- [V] If the reviewer types while the merge runs, their message is `direct` but `joined` (`src/asking.ts:306-309`), so what it asks for is shown first. Same as typing into today's automatic review.
- If it could act: a steered finding (fenced, but read in the same context) could post to GitHub under the reviewer's name. It can't, so the residual risk is **drafting** attacker-chosen text. That's today's automatic-review exposure, times N focuses.

### d. Older releases keep unknown DraftComment fields: **partly**
- [V] Agent edit, old and new: `editDraftComment` mutates the parsed comment in place, so unknown fields survive (`src/store.ts:1318-1333`; same at `v1.9.0`).
- [V] Agent relines: `{ ...comment, … }` keeps them (`src/draft-comments.ts:167`).
- [V] **Reviewer edit in the panel drops them.** `saveDraftComment` → `upsertDraftComment` → `savedOver` keeps only `TRACKING` keys from the stored comment (`src/store.ts:698, 1750-1757`). This is true in old and new code, not just on downgrade.
- [V] `commentShape` is `.strict()` (`src/rpc-contract.ts:31-54`). A new page that sends `focus` back (Undo after Remove, `restore`) is **refused** until the shape lists `focus`/`alsoFlaggedBy`. 03 only updates `before()`, which is the discussion undo, not this path.
- Decision 03 skipped: should a reviewer-edited comment stay "from Docs"? `author` and `evidence` already go on a reviewer edit (`src/draft.ts:59,64`). **Recommend: `focus` goes too.** Otherwise a reviewer-written comment posts as `**Should fix (Docs):**` under their name.

## 2. [V] citation spot-check (22 checked)

| Citation | Result |
|---|---|
| `src/generate.ts:210-296` writer loop | ✓ spawn :219, archive/stop in `finally` |
| `src/generate.ts:49` `waitCap` | ✓ |
| `src/generate.ts:48` pending counts as working | ✓, **but see §3.1**: the deadline still fails it |
| `src/generate.ts:104` `guideWriterMode` | ✓. Lowest mode is `accept-edits`/`auto`, **not read-only** |
| `src/generate.ts:268-273` nudge | ~ off by ~5. Nudge is :262-266 |
| `src/generate.ts:318-320` baseline → check, not review | ✓ |
| `src/generate.ts:320` trigger | ✓ |
| `src/preferences.ts:154` `spawnExecution` | ✓ |
| `src/thread-review.ts:12` `spawningFor` | ✓ |
| `src/store.ts:1294` JSON.parse, no schema | ✓ |
| `src/store.ts:786-787` knobs column | ✓ |
| `src/store.ts:921` old save touches value+knobs only | ✓ :921-922 |
| `src/agent.ts:422-440` queue + effort | ✓ |
| `src/agent.ts:315-324` new-commits message | ✓ |
| `src/draft-comments.ts:122` one per location | ✓ :123 |
| `src/draft-comments.ts:120` `placeProblem` | ✗ defined :77; :120 is the call |
| `src/draft-comments.ts:134` `before()` | ✓, but it isn't the Undo-after-Remove path (§1d) |
| `src/draft.ts:47` DraftComment | ✓ |
| `src/agent-reads.ts:19` ignores other threads | ✓ |
| "nine files import `postedBody`" | ~ 8 import it, plus `src/draft.ts` defines it |
| `docs/guide.md:669` / `lib/knobs.ts:26` all on | ✓ :668 / :26 |
| concurrency-limit skill: one per processor | ✓ |

- [V] Extra check on 03 §4.1 "Read-only tools enforced: yes, by configure". Only true for **plugin** tools. The provider's own shell and edit tools follow `permissionMode`, and `accept-edits` allows edits.
- [V] Extra check on "storage-copy" work: `storage-copy.ts` lists tables from `sqlite_master` / `information_schema` (`src/storage-copy.ts:80-110`). Likely nothing to do there beyond parity tests. `src/merge.test.ts:198` already forces `REVIEW_TABLES` to be complete.

## 3. Failure modes: what would have to be true to break it

### 3.1 Prompt injection / trust (PRODUCT.md, Trust)
- **CLI bypass. [V] Real gap.**
  - `run()` sets `ownReview` from `toolThreadReview ?? formerWorkerReview` (`server.ts:396`).
  - A live focus thread is neither, so `ownReview` is undefined, and `bb review comment add` accepts **any** review (`src/comment-command.ts:78`).
  - So a steered focus with a shell can draft straight into this review or another one, skipping merge, attribution and fencing.
  - [I] Whether a hidden plugin thread can reach `bb` (PATH, `BB_THREAD_ID`) and run commands without an approval at `accept-edits` is unverified. Assume it can under `auto`.
  - Fix: `run()` refuses every write subcommand from a focus thread, live or former, by role.
- **Don't implement `focusThread` inside `threadReview`/`toolThreadReview`.** [V] Those feed `run()`'s `ownReview` and `read_changes_since_review` (`src/feedback-tools.ts:54,81`). Add a separate check in the read tools.
- **Permission mode isn't read-only. [V]** `accept-edits` allows file edits. Focuses run in `project-default` placement (`src/machines.ts:40`), which may be the user's checkout.
  - Exposure is the guide writer's today, times N, and focuses get `read_file`, so they look harder.
  - [I] Ask BB whether a hidden thread can get a read-only or no-workspace environment. If not, say so in Settings.
- **Fence the guide.** The spawn prompt carries "the guide's core (intent, chapters, risk)", written from untrusted PR text. Wrap it in `untrusted()`, as `buildGenerationPrompt` does with earlier chapters (`src/generate.ts:124`).
- Findings fenced for the merge turn, and the merge turn unattended: ✓ (§1c).

### 3.2 Concurrency limits
- [V] Host limit defaults to one thread per processor. Hidden focus threads take slots the user can't see, so the user's own threads sit `pending` for no visible reason. That is thread-management overhead in disguise.
- [V] 03 §7 #11 is false as written: the writer's loop fails a pending worker once the deadline passes (`src/generate.ts:256`). A queued focus times out after `waitCap`.
- Several PRs auto-starting at once (watched repos): 4 focuses × k reviews, all unbounded. Add a **plugin-wide cap** on concurrent focus threads (e.g. 2) and queue the rest in the plugin, not in BB.

### 3.3 Plugin restart mid-run
- 03: "unfinished focuses become failed, threads stop, submitted findings merge".
- Who sends the merge after a restart? It has to recheck PR state and trust, and the review agent's own review may not have finished. Not designed.
- Orphan: a crash between `spawn` returning and the `focus_threads` row → a hidden thread that is never stopped. Sweep on start by `pluginMetadata` or by title (`pluginThreadsTitled`, `src/thread-review.ts:50`, already pages hidden + archived).
- A focus thread still running after its run failed can still call `submit_focus_findings`. The tool must refuse any run that isn't `finding`.

### 3.4 Push mid-run
- `beginGuide` stops the run: ✓ for a guide rebuild.
- Gap: a push with no rebuild (re-review gets a check, not a guide). Findings were placed against the old diff, and `placeProblem` in the merge turn will refuse many of them. Those should become `not-checked: diff changed`, not "dropped: not confirmed".

### 3.5 Stop
- Stop aborts the focuses. 03 is silent on the merge message:
  - **Queued**: delete it (`threads.queuedMessages.delete`, SDK:18796-18800).
  - **Running**: stop the turn or let it finish? Pick one.
- **The user can delete or edit the queued merge message in BB's queue.** The run then sits `merging` forever. It needs a watchdog: review agent idle after dispatch with findings still `pending` → `not-checked`.

### 3.6 One focus fails or times out
- Others continue, the merge uses what arrived: ✓ well covered.
- Gap: a focus that hits a permission prompt at `accept-edits` waits on a pending interaction no one sees, until `waitCap` (up to 60 min, `src/generate.ts:49`). Fail it on its first pending interaction (`threads.interactions.list`).

### 3.7 Merge turn doesn't settle every finding
- Fail closed + one nudge: ✓ right call.
- Scale: 4 focuses × 15 findings = 60 `read_file` checks in one queued turn, ahead of whatever the reviewer types next. Cap what goes to the merge (e.g. 20 total, severity-ordered, the rest `not-checked`). Risk of compaction mid-merge [I].
- "Turn ended" detection: use the mark ledger's `dispatchedAt` plus the next idle (`src/asking.ts`). Specify it; today it's implied.

### 3.8 Cost blowup
- Each focus reads the whole patch, and the merge re-reads files. The cost is per review × focuses × auto-started reviews.
- Override lets one focus pick an expensive model with no ceiling.
- Fixes: the plugin-wide cap (§3.2), the findings cap (§3.7), tokens per run shown in Finish review and Settings (§1b).

### 3.9 "Off = today exactly"
- [V] The review agent's tools are global per role (`server.ts:368-378`). Adding `list_focus_findings`, `dismiss_focus_finding` and a `finding` parameter on `add/edit_draft_comment` changes every agent's tool schema, plus an `ASSISTANT_TOOLS` restart, **with the feature off**.
- Fix:
  - Grant the merge tools in `configure` only while focuses are on, as `reviewAgentActs` gates write tools (`server.ts:375`).
  - Use a separate `keep_focus_finding({ id, … })` instead of a parameter on existing tools.
  - Phase 1's off-test compares the tool list, the instructions and `registrations` too, not only spawns and messages.

### 3.10 Hidden thread cleanup / former workers
- [V] `former-workers` is a kv array capped at 500 (`src/former-workers.ts:10`). 4 focus records per review pushes out former assistants after ~100 reviews.
- An evicted former assistant then reads as "relayed from the reviewer" (01 §7.4 #26). That is a trust regression.
- Fix: keep focus threads in `focus_threads` (already planned) and have `ownThread` consult it. Don't record focus threads in `former-workers`.
- Archived hidden threads build up in BB's database: ~4 per review, forever unless the review is deleted [I]. Consider deleting focus threads at run end, since "ask a focus later" is out of scope.

### 3.11 Storage copy / merge of new tables
- `REVIEW_TABLES` completeness is test-enforced [V `src/merge.test.ts:198`].
- `mergeReview`: moving both reviews' `focus_findings` breaks 03's own "only the latest run per review" rule. Drop the archived review's findings, which are for another head anyway. Move `focus_threads` rows, or stop and delete those threads.
- `focus_threads.thread_id` as PK across reviews: ✓.

### 3.12 Trigger ambiguity
- `startAutomaticReview` returns `"conversation"` without reviewing when a chat already exists and nothing was clicked (`src/agent.ts:317-318`). Do focuses run then? 03 says "wherever the automatic review starts". Say yes or no explicitly.

## 4. The 8 pushbacks

| # | Verdict | Why |
|---|---|---|
| 1 General = agent's own pass | Agree | Off = today for free. The agent defends what it researched |
| 2 No separate verifier | Agree | One gatekeeper plus fail-closed; C's seam stays open. Merge effort covers "aggregate settings" |
| 3 `**Should fix (Docs):**` | Agree | One label reads human. Pre-existing still stacks two; acceptable |
| 4 Phase the editor | Agree, conditionally | Only if Phase 4 ships in release 1. The owner asked for per-focus override in release 1, and it lives in Phase 4 |
| 5 No rerun on push | Agree | Rerun-per-push is the top complaint (02 §1.1). Manual Run again is enough |
| 6 Leave `automaticReview` alone | Agree, strongly | Changing it changes off |
| 7 Opt-in, not a knob | Agree | `runRepoChecks:false` precedent [V `lib/review-preferences.ts:71`] |
| 8 No focus filter yet | Agree | Two sources don't need a filter |

## 5. UX: thread-management overhead

- Mostly avoided: no visible threads, one addressee, one switch. ✓
- What the user still manages:
  - **Invisible slot use** (§3.2). Their own threads queue behind hidden ones. Show "Focuses using 2 agent slots" in the strip while it runs.
  - **The merge message in the agent's queue.** It's visible, deletable and blocks their next ask (§3.5, §3.7). Mark it as the plugin's ("from Code Review Workspace"), and keep it short by capping findings.
  - **Dismissible notices**: failure, older-commit, not-checked "Check again". One per run at most; fold them into a single strip line.
  - Finish review's dropped-findings fold: optional, fine.
- Reviewer edit drops the focus (§1d recommendation): no surprise label under their name.

## 6. Licensing vs 04

- Covered: Apache §4 (a) license copy, (b) change notice in the header **and** the editor's "changed" line, (c) "Anthropic, PBC" + URL + SHA, (d) n/a; re-pin; per-plugin-dir LICENSE check; claude-security excluded; trademarks; pr-agent ideas only; notices test. ✓
- Gaps:
  - **Runtime loading.** 03 doesn't say how `focus-templates/docs.md` reaches the installed plugin (fs read at runtime vs bundled string). 04 §5.2 flags that a bundle may strip headers. Pick one. If bundled, the notices file must still ship [I].
  - **Secondary source.** 04 §3.1 suggests merging `claude-code-action`'s `documentation-accuracy-reviewer` (MIT). 03 is silent. State "not used", or add its MIT file and notices entry.
  - **Co-holder.** 04 §5.3 #8: confirm with Pritam Sharma before deciding "no per-file line of our own".
  - **The old `code-review` SHA** (pre-LICENSE, 04 §1.2): not used by 03; say so in notices, to close the question.

## 7. Phasing

- **Phase 0 isn't separable in release terms.** It freezes schema ("can't edit shipped statements") before Phase 1 proves it. Review it as its own PR, but **don't release it before Phase 1**.
  - Trim `FocusSettings` to what Phase 1 reads. The JSON column needs no migration later.
- **Phase 1 is not shippable alone.** Stop, restart recovery, a rebuild stopping the run, and push mid-run are all in Phase 3. A release with Phase 1 alone has runs that can't be stopped and survive restarts as `finding` forever. Move those into Phase 1, which is the minimum *safe* slice, and keep only the strip polish and the Finish review fold in Phase 3.
- Phase 1 could be smaller: drop `alsoFlaggedBy` and the "also flagged by" state line (merge rule 4 can fold without attributing). Keep `dismiss_focus_finding`: fail-closed accounting needs it.
- Phase 2 (label) and Phase 4 (editor): each reviewable alone. ✓
- "Release 1" is undefined in 03. The owner asked for override + templates in release 1, so release 1 = Phases 0-4.

## 8. Top 5 changes, ranked

1. **Lock down focus threads as untrusted shell agents.**
   - `run()` refuses `bb review` write subcommands (and relays) from focus threads, live or former.
   - Read tools check `focusThread` separately; don't extend `threadReview`.
   - Fence the guide core in the spawn prompt.
   - Fail a focus on any pending permission interaction.
   - Say plainly in Settings that `accept-edits` isn't read-only (§3.1, §3.6).
2. **Make Phase 1 safe to release.**
   - Stop (including the queued or running merge message), restart recovery and orphan sweep via `pluginMetadata`, rebuild/push handling, and a merge watchdog for a deleted queued message.
   - Fix the deadline-vs-pending claim (§3.3-3.5, §7).
3. **Off = today for the agent's tools.** Merge tools granted only while on, via `configure`. A separate `keep_focus_finding` instead of a `finding` parameter. The off-test covers the tool list, instructions and registrations (§3.9).
4. **Bound concurrency and cost.**
   - Plugin-wide cap on concurrent focus threads.
   - Cap findings sent to the merge (~20, severity-ordered).
   - Show tokens per run from `thread/tokenUsage/updated` (§1b, §3.2, §3.7, §3.8).
5. **Fix the attribution data path.**
   - Drop `focus` on a reviewer edit.
   - Add `focus`/`alsoFlaggedBy` to the strict `commentShape`.
   - Keep focus threads out of the 500-entry `former-workers` kv; use `focus_threads`.
   - `mergeReview` drops the archived review's findings (§1d, §3.10, §3.11).
