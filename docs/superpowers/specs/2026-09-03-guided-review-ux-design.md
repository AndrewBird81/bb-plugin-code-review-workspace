# Guided Review — UX overhaul (viewed-state, readable sidebar, floating agent)

Date: 2026-09-03
Status: shipped by 0.2, then superseded in part: the assistant is now a BB thread, and `agent_messages` is a legacy read-only table. Historical; DESIGN.md describes the UI as it is.

## Goal

Three reviewer-facing improvements to the Guided Review panel, shipped together:

1. **Per-file "Viewed" + collapse** — a GitHub-style checkbox that collapses a
   file once reviewed, with progress ("3 / 8 viewed") and remembered across
   reloads.
2. **Readable, meaningful sidebar** — stop clipping chapter titles, say what each
   risk flag *means*, and tag files that are low-value to review (tests,
   generated, lockfiles) so the reviewer can skip them. Chapters expand into a
   per-file list that doubles as navigation.
3. **Floating agent** — replace the one-shot "Ask the agent" popover with a
   draggable, movable chat window opened from an agent icon; multi-turn; knows
   the current file/chapter; supports highlight-to-ask; backed by one persistent
   *visible* bb thread per review that can be opened standalone.

Non-goals: changing the guide-generation prompt/schema; streaming token output
(each agent turn resolves as a whole message in v1); mobile/coarse-pointer
polish beyond what the existing `coarse-pointer-sizing` helpers already give.

## Constraints & existing shape

- Panel is `ReviewWorkspace` → `ReviewHeader` + `ChapterNav` sidebar + main area
  (Diff/Threads) + `DraftTray`. Routed by `ReviewPanel` (must stay a plain
  function, not `memo()` — SDK slot requirement).
- `DiffViewer` renders every file of the active chapter stacked via
  `@pierre/diffs` `FileDiff` (prop is `fileDiff`, theme nested under `options`).
- Store is SQLite via `bb.storage.database()` + `bb.storage.migrate`; migrations
  are an append-only array. RPC contract in `src/rpc-contract.ts`; the panel
  imports only its *type*.
- Realtime: `useRealtime("review:${targetKey}", …)` already re-loads on publish;
  the backend publishes to that channel.
- Guide schema (`src/guide.ts`) is **unchanged**: sections have
  `{ id, title, overview, risk?: low|medium|high, diffs: {file, summary}[] }`.
  The chapter `overview` is used as the human "why" behind the risk flag.
- SDK thread API (verified in `@get-bb/plugin-sdk` types): `threads.spawn`,
  `threads.send` (follow-up message to an existing thread), `threads.wait`,
  `threads.output`, `threads.open` (surface a thread in the client UI),
  `threads.archive/stop`.

## Data model (new migrations, append to the existing array)

```sql
CREATE TABLE IF NOT EXISTS file_views (
  target_key TEXT NOT NULL, file TEXT NOT NULL,
  hash TEXT NOT NULL, viewed_at INTEGER NOT NULL,
  PRIMARY KEY (target_key, file));

CREATE TABLE IF NOT EXISTS agent_threads (
  target_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, target_key TEXT NOT NULL,
  role TEXT NOT NULL, text TEXT NOT NULL, context_json TEXT, created_at INTEGER NOT NULL);
```

- `file_views.hash` = sha256 of that file's scoped diff text at the moment
  Viewed was ticked. On load the panel recomputes the current hash per file; a
  mismatch means "changed since viewed" (auto-uncheck after re-review). No git
  needed — the patch is the source of truth.
- `agent_messages` is the display source of truth for the floating chat; the bb
  thread is the compute + the "open as thread" affordance.

Store gains: `getFileViews`, `setFileViewed`, `clearFileViews` (on re-review);
`getAgentThread`/`setAgentThread`; `listAgentMessages`/`appendAgentMessage`.

## Shared module `src/classify.ts` (pure, unit-tested)

```ts
type FileCategory = "test" | "generated" | "lockfile" | "docs" | "config" | "code";
interface FileClass { category: FileCategory; skippable: boolean; label: string; }
function classifyFile(path: string): FileClass;
```

Deterministic heuristics on path/extension: `*.test.*` / `*.spec.*` /
`__tests__/` / `*.snap` → test; `*.lock` / `package-lock.json` /
`pnpm-lock.yaml` / `yarn.lock` → lockfile; `dist/` / `build/` / `*.min.*` /
`*.generated.*` → generated; `*.md` / `docs/` → docs; dotfiles / `*.json` config
/ `*.yml` → config; else code. `skippable = category ∈ {test, generated,
lockfile}`. `label` is a short human tag ("test", "generated", "lockfile").
No LLM. Used by the sidebar and the per-file diff badge.

## Feature 1 — Viewed + collapse (`DiffViewer`)

- New `FileDiffCard` wraps each `FileDiff`: header row = path · +/− counts ·
  category badge (from `classifyFile`) · **Viewed** checkbox. Ticking collapses
  the body and dims the header; unticking re-expands.
- Viewed state persisted through `setFileViewed({ targetKey, file, hash, viewed })`
  and hydrated via `getFileViews`. Realtime `review:${targetKey}` keeps it synced.
- Per-file hash computed client-side from the same scoped diff text
  `DiffViewer` already builds; a helper `hashFileDiff(text)` (sha256, hex) lives
  in `src/classify.ts`'s sibling `src/diff-hash.ts` (pure, tested) so it can be
  shared/tested without the DOM.
- Diff toolbar (the existing Diff/Threads row) gains a **"N / M viewed"** counter
  for the active chapter and a "Collapse viewed" / "Mark all viewed" control.
- A **"changed since viewed"** pill shows on a file whose current hash ≠ stored
  hash (re-review moved it); it counts as not-viewed for progress.

## Feature 2 — Readable sidebar (`ChapterNav`)

- Titles wrap to **2 lines** (`line-clamp-2`, not hard `truncate`); the overview
  snippet always shows (not only when active).
- Risk pill becomes explicit worded text — "High risk" / "Medium" / "Low" — with
  color and a tooltip whose body is the chapter `overview` (the "why").
- Each chapter is **expandable** into a per-file list. Each file row: category
  badge, Viewed check (shared state with Feature 1), and a click that selects the
  chapter and **scrolls to that file's card** in the diff (via a ref registry /
  `scrollIntoView` keyed by file path; `onSelectFile(file)` raised to
  `ReviewWorkspace`).
- Skippable files get a muted style + "skip" tag; a chapter whose files are all
  skippable shows a subtle "mostly tests — skim" hint. Count line becomes
  "5 files · 2 skippable".
- Expansion state is local UI state (not persisted); active chapter auto-expands.

## Feature 3 — Floating agent (`AgentDock`, replaces `AssistPopover`)

- An **agent-icon FAB** anchored bottom-right of the panel opens/closes the dock.
  `AssistPopover` and its placement in `DraftTray` are removed.
- `AgentDock` is a draggable, resizable floating card portaled into the panel
  root via existing `lib/portal-scope`. Dragged by its header; position/size
  clamped to panel bounds and persisted to `localStorage`
  (`gr:agentdock:<targetKey>` → `{x,y,w,h,open}`). Minimize/close buttons.
  `prefers-reduced-motion` disables open/drag transitions.
- Chat body renders `agent_messages` (user/assistant bubbles). Composer always
  carries a **context chip** for the current chapter + focused file; the chip is
  editable/removable. Sending calls `askAgent`.
- **Highlight-to-ask**: a selection listener scoped to the diff area detects a
  non-empty selection within a `FileDiffCard`, shows a small floating "Ask agent
  about this" button near the selection, and on click captures
  `{ file, startLine, endLine, code }`, opens the dock, and inserts it as the
  composer context chip (focus composer).
- Backend `askAgent({ targetKey, message, context })`:
  1. Ensure a persistent thread exists for `targetKey` (`getAgentThread`; if
     none, `threads.spawn` a **visible** thread titled "Review agent:
     <target>", seeded with a system preamble: change intent, guide outline
     (chapter titles + overviews), and how to read the stored patch; save via
     `setAgentThread`).
  2. `appendAgentMessage(role:"user", text, context)`.
  3. Build the turn text from `message` + serialized `context` (file + line
     range + code fence) and `threads.send` it to the thread.
  4. `threads.wait({ status:"idle" })`, read `threads.output`, normalize to a
     string (same both-shapes tolerance as today's `runAssist`).
  5. `appendAgentMessage(role:"assistant", text: answer)`; publish
     `review:${targetKey}` so the dock refreshes.
- `openAgentThread({ targetKey })` → ensure thread, `threads.open` it, return
  `{ threadId }`. Header link "Open as bb thread ↗" calls it.
- `getAgentMessages({ targetKey })` → the log for hydration.
- Old `assist` RPC + `runAssist` + `AssistPopover` are retired (only the popover
  used them). `src/assist.ts` is replaced by `src/agent.ts` housing the
  spawn/send/wait/read logic; `assist.test.ts` becomes `agent.test.ts`.

## RPC contract additions (`src/rpc-contract.ts`)

```
getFileViews(targetKey) -> { views: { file, hash, viewedAt }[] }
setFileViewed({ targetKey, file, hash, viewed }) -> { ok }
getAgentMessages(targetKey) -> { messages: { id, role, text, context, createdAt }[] }
askAgent({ targetKey, message, context? }) -> { answer }
openAgentThread(targetKey) -> { threadId }
```

`context` shape: `{ file: string, startLine?: number, endLine?: number, code?: string,
chapterId?: string }`. Remove `assist`.

## Testing

- **Pure/unit**: `classify.test.ts` (category + skippable across representative
  paths), `diff-hash.test.ts` (stable hash, order-independent within a file,
  changes when text changes).
- **Store**: extend `store.test.ts` for file_views upsert/read/clear and
  agent_messages append/list ordering, agent_threads upsert.
- **RPC/backend**: `agent.test.ts` drives `askAgent` against the SDK
  recorded-call test double (asserts spawn-once-then-send, wait, output
  normalization, message log growth); `rpc-*.test.ts`-style coverage for
  file-views round-trip.
- **Components** (Testing Library, jsdom): `ChapterNav.test.tsx` (no clip / 2-line
  title, skip tag, expand → file rows, onSelectFile fires); `DiffViewer` viewed
  toggle collapses + counter; `AgentDock.test.tsx` (opens from FAB, renders log,
  context chip present, send calls rpc, "open as thread" calls rpc). Drag math
  extracted to a pure `clampToBounds`/`nextDockRect` helper and unit-tested
  rather than simulating pointer physics.

## Rollout / risk

- Guide schema unchanged → every existing review gets the new sidebar + viewed UI
  with no regeneration.
- `assist` removal is internal (only `AssistPopover` called it).
- Migrations are additive; older DBs upgrade in place.
- The floating window is confined to the panel container (portal-scope) and
  clamped, so it can't escape into the rest of the bb UI.
```
