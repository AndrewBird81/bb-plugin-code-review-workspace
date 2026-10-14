# Guided Review — Phase 2 Implementation Plan

> **Status: shipped by 0.1. A historical record, not pending work: don't execute it.** README and DESIGN.md describe the plugin as it is.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extend the Guided Review plugin with the best-in-class in-bb review features: reply to / resolve existing PR review threads, CI status, chapter risk flags, and re-review on new commits — plus the `gitRef` pass-through fix. (No HTML export or share service — explicitly out of scope.)

**Architecture:** Builds directly on the Phase 1 plugin. New `gh` builders (structured checks, GraphQL review threads + resolve, PR head SHA), two new store columns (head SHA + cwd) for re-review, new RPC methods, a generation tweak (risk + authoritative gitRef), and panel additions (CI badge, risk badges, a threads panel with reply/resolve, and a "new commits → re-review" banner).

**Tech Stack:** Same as Phase 1 — TypeScript, `@get-bb/plugin-sdk`, Zod, React/Tailwind (host tokens), `@pierre/diffs`, `gh` (REST + GraphQL), vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-guided-review-design.md` (§11 Phase 2)

## Global Constraints

- Branch `feat/phase2` off `main`. Same conventions as Phase 1.
- All GitHub access via `gh` shelled server-local (argv arrays, no `shell:true`); GraphQL via `gh api graphql`. No token handling.
- Store migrations are APPEND-ONLY (never edit/reorder shipped statements). Current store has 5 migrate statements (last = `ALTER TABLE reviews ADD COLUMN project_id TEXT`); Phase 2 appends more.
- RPC results must be strict JSON (no `undefined`-valued keys — round-trip store objects through `JSON.parse(JSON.stringify(...))` as the existing read handlers do).
- New rpc-contract methods use `.strict()` inputs. Panel calls only via `useRpc`. Host token classes only in UI. Test files import `{ test, expect }` (and `vi` where mocking) from `"vitest"`.
- Verify SDK/`gh` shapes against reality (`gh ... --help`, `node_modules/@get-bb/plugin-sdk/bundled-types/*.d.ts`); adapt provisional code to typecheck.
- `bb.agents.configure` is already registered once (Phase 1) — do NOT add a second `configure`.

## File Structure (changes)

```
src/gh.ts              # + ghPrChecksJsonArgs, ghPrHeadArgs, ghReviewThreadsArgs, ghReplyThreadArgs, ghResolveThreadArgs, ghUnresolveThreadArgs
src/store.ts           # + head_sha, cwd columns; headSha/cwd on ReviewMeta
src/review-command.ts  # store headSha + cwd; extract reusable resolveAndStore()+ for re-review
src/rereview.ts        # NEW: rerunReview(deps, targetKey) — re-fetch diff + re-kick generation for a stored target
src/threads.ts         # NEW: pure parsers for gh checks JSON + graphql review-threads JSON
server.ts              # + rpc: getChecks(structured), getReviewThreads, replyToThread, resolveThread, unresolveThread, checkForUpdates, rereview; generate_review_guide stamps review.gitRef
src/rpc-contract.ts    # + the new method schemas; getChecks output shape changes
skills/guided-review-generate/SKILL.md  # + risk instruction
components/ReviewHeader.tsx   # + CI badge (bucket) + reviewDecision
components/ChapterNav.tsx      # + risk badge per section
components/ThreadsPanel.tsx    # NEW: existing PR threads, reply + resolve/unresolve
components/RereviewBanner.tsx  # NEW: "N new commits — Re-review" banner + button
components/ReviewWorkspace.tsx # wire checks/threads/updates + the new components
```

---

## Task 1: `gh` builders + pure parsers (`src/gh.ts`, `src/threads.ts`)

**Files:** modify `src/gh.ts`; create `src/threads.ts`; tests `src/gh.test.ts` (extend), `src/threads.test.ts`.

**Interfaces produced:**
- `ghPrChecksJsonArgs(number, repo?): string[]`
- `ghPrHeadArgs(number, repo?): string[]` (headRefOid + reviewDecision)
- `ghReviewThreadsArgs(owner, repo, number): string[]`
- `ghReplyThreadArgs(repo, number, inReplyToCommentId): string[]` (stdin `{body}`)
- `ghResolveThreadArgs(threadId): string[]`, `ghUnresolveThreadArgs(threadId): string[]`
- `parseChecks(json): { bucket: "pass"|"fail"|"pending"|"none"; checks: {name,bucket,state,link?}[] }`
- `parseReviewThreads(json): { threads: {id,isResolved,isOutdated,path,line,comments:{id,databaseId,author,body}[]}[] }`

- [ ] **Step 1: Extend `src/gh.ts` with the new builders**

```ts
export function ghPrChecksJsonArgs(number: number, repo?: string): string[] {
  const a = ["pr", "checks", String(number), "--json", "name,state,bucket,link"];
  return repo ? [...a, "-R", repo] : a;
}
export function ghPrHeadArgs(number: number, repo?: string): string[] {
  const a = ["pr", "view", String(number), "--json", "headRefOid,reviewDecision"];
  return repo ? [...a, "-R", repo] : a;
}
const REVIEW_THREADS_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){ pullRequest(number:$number){
    reviewThreads(first:100){ nodes{
      id isResolved isOutdated path line
      comments(first:100){ nodes{ id databaseId author{login} body } } } } } } }`;
export function ghReviewThreadsArgs(owner: string, repo: string, number: number): string[] {
  return ["api", "graphql", "-f", `query=${REVIEW_THREADS_QUERY}`,
    "-F", `owner=${owner}`, "-F", `repo=${repo}`, "-F", `number=${number}`];
}
export function ghReplyThreadArgs(repo: string, number: number, inReplyToCommentId: number): string[] {
  return ["api", "-X", "POST", `repos/${repo}/pulls/${number}/comments/${inReplyToCommentId}/replies`, "--input", "-"];
}
export function ghResolveThreadArgs(threadId: string): string[] {
  return ["api", "graphql", "-f",
    `query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`,
    "-F", `id=${threadId}`];
}
export function ghUnresolveThreadArgs(threadId: string): string[] {
  return ["api", "graphql", "-f",
    `query=mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`,
    "-F", `id=${threadId}`];
}
```

- [ ] **Step 2: Create `src/threads.ts` (pure parsers)**

```ts
export interface CheckItem { name: string; bucket: string; state: string; link?: string }
export interface ChecksSummary { bucket: "pass" | "fail" | "pending" | "none"; checks: CheckItem[] }

export function parseChecks(raw: string): ChecksSummary {
  let items: any[] = [];
  try { items = JSON.parse(raw); } catch { return { bucket: "none", checks: [] }; }
  if (!Array.isArray(items) || items.length === 0) return { bucket: "none", checks: [] };
  const checks: CheckItem[] = items.map((c) => ({ name: c.name, bucket: c.bucket, state: c.state, link: c.link }));
  const buckets = new Set(checks.map((c) => c.bucket));
  const bucket = buckets.has("fail") ? "fail" : buckets.has("pending") ? "pending" : "pass";
  return { bucket, checks };
}

export interface ThreadComment { id: string; databaseId: number; author: string; body: string }
export interface ReviewThread {
  id: string; isResolved: boolean; isOutdated: boolean; path: string | null; line: number | null;
  comments: ThreadComment[];
}
export function parseReviewThreads(raw: string): { threads: ReviewThread[] } {
  let root: any;
  try { root = JSON.parse(raw); } catch { return { threads: [] }; }
  const nodes = root?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const threads: ReviewThread[] = nodes.map((t: any) => ({
    id: t.id, isResolved: !!t.isResolved, isOutdated: !!t.isOutdated, path: t.path ?? null, line: t.line ?? null,
    comments: (t.comments?.nodes ?? []).map((c: any) => ({
      id: c.id, databaseId: c.databaseId, author: c.author?.login ?? "unknown", body: c.body ?? "",
    })),
  }));
  return { threads };
}
```

- [ ] **Step 3: Tests** — extend `src/gh.test.ts` for the 6 new builders (exact argv arrays incl `-R` when repo given; graphql args contain the query + `-F` vars); create `src/threads.test.ts` with:
  - `parseChecks` on `[]` / invalid → `{bucket:"none",checks:[]}`; a mix with a `fail` bucket → `bucket:"fail"`; all `pass` → `"pass"`; a `pending` present (no fail) → `"pending"`.
  - `parseReviewThreads` on a realistic graphql response (nested `data.repository.pullRequest.reviewThreads.nodes`) → flattened threads with comments; on invalid JSON → `{threads:[]}`.

Write each test first (RED), implement, GREEN. Commit: `feat: gh builders + parsers for checks and review threads`.

---

## Task 2: Store columns + re-review helper (`src/store.ts`, `src/review-command.ts`, `src/rereview.ts`)

**Files:** modify `src/store.ts`, `src/review-command.ts`; create `src/rereview.ts`; tests `src/store.test.ts` (extend), `src/rereview.test.ts`.

**Interfaces produced:**
- `ReviewMeta` gains `headSha?: string`, `cwd?: string`.
- `rerunReview(deps, targetKey): Promise<{ ok: boolean; error?: string }>` — re-fetches the diff for a stored review, re-saves the patch, sets status `generating`, re-kicks `generateGuide`.

- [ ] **Step 1: `src/store.ts` — append two migrations + fields.** Append to the `bb.storage.migrate` array (as the last two statements, after the `project_id` ALTER):

```ts
`ALTER TABLE reviews ADD COLUMN head_sha TEXT`,
`ALTER TABLE reviews ADD COLUMN cwd TEXT`,
```
Add `headSha?: string; cwd?: string;` to `ReviewMeta`. In `saveReview`, add `head_sha=@headSha, cwd=@cwd` to the INSERT columns + `ON CONFLICT` SET, and bind `headSha: m.headSha ?? null, cwd: m.cwd ?? null` (ALWAYS bound — null when absent). In `rowToMeta`, add `headSha: r.head_sha ?? undefined, cwd: r.cwd ?? undefined`.

- [ ] **Step 2: Confirm Task 7's store tests still pass** (`npm test -- src/store.test.ts`). Add one test: saveReview with `{headSha:"abc", cwd:"/repo"}` round-trips via getReview.

- [ ] **Step 3: `src/review-command.ts` — capture headSha + cwd.**
  - For PR mode: use `ghPrHeadArgs` (or add `headRefOid` to the existing `ghPrViewArgs` fields) to read `headRefOid`; set `meta.headSha = pr.headRefOid` (if you extend PR_FIELDS with `headRefOid`, the existing `pr` object already has it — prefer that: add `headRefOid` to `PR_FIELDS` in gh.ts and set `meta.headSha = pr.headRefOid`).
  - Always: `meta.cwd = ctx.cwd;`
  - (Keep the existing behavior otherwise.)

- [ ] **Step 4: `src/rereview.ts` — reusable re-run.** It resolves the stored target back into a fetch and re-kicks generation. Consumes the same `Deps` shape as `runReviewCommand`.

```ts
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";
import { ensureGitHeaders } from "./patch";
import { generateGuide } from "./generate";
import { ghPrDiffArgs, ghPrHeadArgs, gitDiffArgs } from "./gh";

interface Deps {
  bb: BbPluginApi; store: Store;
  gh: { runGh: typeof import("./gh").runGh; runGit: typeof import("./gh").runGit };
}

export async function rerunReview(deps: Deps, targetKey: string): Promise<{ ok: boolean; error?: string }> {
  const m = deps.store.getReview(targetKey);
  if (!m || !m.projectId) return { ok: false, error: "Unknown review or missing project." };

  let patch = "";
  if (m.kind === "pr" && m.number) {
    const diff = await deps.gh.runGh(ghPrDiffArgs(m.number, m.repo));
    if (diff.code !== 0) return { ok: false, error: diff.stderr || "gh pr diff failed" };
    patch = diff.stdout;
    const head = await deps.gh.runGh(ghPrHeadArgs(m.number, m.repo));
    if (head.code === 0) { try { m.headSha = JSON.parse(head.stdout).headRefOid; } catch { /* keep old */ } }
  } else if (m.gitRef) {
    if (!m.cwd) return { ok: false, error: "Local-ref re-review needs the original working dir; re-run `bb review` in the terminal." };
    const diff = await deps.gh.runGit(gitDiffArgs(m.gitRef), { cwd: m.cwd });
    if (diff.code !== 0) return { ok: false, error: diff.stderr || "git diff failed" };
    patch = diff.stdout;
  } else {
    return { ok: false, error: "Review has no re-runnable target." };
  }
  if (!patch.trim()) return { ok: false, error: "No changes found." };

  deps.store.savePatch(targetKey, ensureGitHeaders(patch));
  deps.store.saveReview({ ...m, status: "generating" });
  void generateGuide(deps.bb, deps.store, targetKey, m.projectId).catch(() => deps.store.setStatus(targetKey, "error"));
  return { ok: true };
}
```

- [ ] **Step 5: `src/rereview.test.ts`** — with `gh`/`git` runners stubbed (return a small diff) and `sdk.threads` spawn/wait/etc stubbed, assert `rerunReview` re-saves the patch, sets status `generating`, and returns `{ok:true}`; and that a local-ref review with no `cwd` returns `{ok:false}`.

Commit: `feat: store head SHA + cwd; re-review helper`.

---

## Task 3: RPC surface (`src/rpc-contract.ts`, `server.ts`)

**Files:** modify both; test `src/rpc-phase2.test.ts`.

**Methods (add to contract + handlers):**
- `getChecks` — CHANGE output to `{ bucket: string, checks: any[] }` (structured via `ghPrChecksJsonArgs` + `parseChecks`). (Update the Phase 1 raw-string `getChecks`.)
- `getReviewThreads({targetKey})` → `{ threads: any[] }` (GraphQL via `ghReviewThreadsArgs` + `parseReviewThreads`; `owner`/`repo` split from `m.repo`).
- `replyToThread({targetKey, inReplyTo, body})` → `{ ok: boolean, error? }` (REST reply, stdin `{body}`).
- `resolveThread({targetKey, threadId})` / `unresolveThread({targetKey, threadId})` → `{ ok, error? }` (GraphQL mutation; `r.code===0` → ok).
- `checkForUpdates({targetKey})` → `{ hasNewCommits: boolean, current?: string, stored?: string }` — PR only: `ghPrHeadArgs` → compare `headRefOid` to `m.headSha`.
- `rereview({targetKey})` → `{ ok, error? }` — calls `rerunReview(...)`.

- [ ] **Step 1: contract** — add the methods (inputs `.strict()`), and change `getChecks` output to `z.object({ bucket: z.string(), checks: z.array(z.any()) })`.

- [ ] **Step 2: handlers in `server.ts`** — e.g.:

```ts
async getChecks({ targetKey }) {
  const m = store.getReview(targetKey);
  if (!m || m.kind !== "pr" || !m.number) return { bucket: "none", checks: [] };
  const r = await runGh(ghPrChecksJsonArgs(m.number, m.repo));
  const parsed = parseChecks(r.code === 0 ? r.stdout : "");
  return { bucket: parsed.bucket, checks: parsed.checks };
},
async getReviewThreads({ targetKey }) {
  const m = store.getReview(targetKey);
  if (!m || m.kind !== "pr" || !m.number || !m.repo) return { threads: [] };
  const [owner, repo] = m.repo.split("/");
  const r = await runGh(ghReviewThreadsArgs(owner, repo, m.number));
  return { threads: parseReviewThreads(r.code === 0 ? r.stdout : "").threads };
},
async replyToThread({ targetKey, inReplyTo, body }) {
  const m = store.getReview(targetKey);
  if (!m || m.kind !== "pr" || !m.number || !m.repo) return { ok: false, error: "Not a PR." };
  const r = await runGh(ghReplyThreadArgs(m.repo, m.number, inReplyTo), { stdin: JSON.stringify({ body }) });
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr || "reply failed" };
},
async resolveThread({ targetKey, threadId }) {
  const r = await runGh(ghResolveThreadArgs(threadId));
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr || "resolve failed" };
},
async unresolveThread({ targetKey, threadId }) {
  const r = await runGh(ghUnresolveThreadArgs(threadId));
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr || "unresolve failed" };
},
async checkForUpdates({ targetKey }) {
  const m = store.getReview(targetKey);
  if (!m || m.kind !== "pr" || !m.number) return { hasNewCommits: false };
  const r = await runGh(ghPrHeadArgs(m.number, m.repo));
  if (r.code !== 0) return { hasNewCommits: false };
  let head: any; try { head = JSON.parse(r.stdout); } catch { return { hasNewCommits: false }; }
  return { hasNewCommits: !!m.headSha && head.headRefOid !== m.headSha, current: head.headRefOid, stored: m.headSha };
},
async rereview({ targetKey }) {
  return rerunReview({ bb, store, gh: { runGh, runGit } }, targetKey);
},
```
Import the new gh builders + `parseChecks`/`parseReviewThreads` + `rerunReview` at top of server.ts.

- [ ] **Step 3: `src/rpc-phase2.test.ts`** — via `createFakePluginHost` + `vi.mock("./gh")`. Seed a PR review with `createStore(bb)`. Assert: `getChecks` returns a structured bucket; `getReviewThreads` returns parsed threads; `resolveThread`/`replyToThread` return `{ok:true}` and the mock was called with the right args; `checkForUpdates` returns `hasNewCommits:true` when the mocked head differs from the stored `headSha`.

Commit: `feat: phase 2 rpc (checks, threads, reply/resolve, updates, rereview)`.

---

## Task 4: Generation — risk flags + authoritative gitRef

**Files:** modify `skills/guided-review-generate/SKILL.md`, `server.ts` (the `generate_review_guide` tool); test extend `src/generate.test.ts`.

- [ ] **Step 1: SKILL.md** — add to step 3: "Assign each section a `risk` of `low`, `medium`, or `high` reflecting the blast radius / likelihood of bugs in that chapter's changes (public API, auth, data, and concurrency changes trend higher; docs/config trend lower)." Note `risk` is one of exactly `low|medium|high`.

- [ ] **Step 2: `generate_review_guide` tool (server.ts)** — after coverage passes and BEFORE `store.saveGuide`, stamp the authoritative review ref from the store so the guide never carries a wrong `gitRef`:

```ts
const meta = store.getReview(targetKey);
if (meta?.gitRef) v.guide.review = { gitRef: meta.gitRef, ...(meta.base ? { base: meta.base } : {}) };
store.saveGuide(targetKey, v.guide);
```

- [ ] **Step 3: test** — extend `src/generate.test.ts`: after seeding a review with a known `gitRef`, submit a guide whose `review.gitRef` is wrong (or absent); assert the STORED guide's `review.gitRef` equals the seeded meta's `gitRef` (stamped), and that a guide with a `risk` on a section still validates/saves.

Commit: `feat: chapter risk flags + authoritative guide gitRef`.

---

## Task 5: Panel — CI badge, risk badges, threads panel, re-review banner

**Files:** modify `components/ReviewHeader.tsx`, `components/ChapterNav.tsx`, `components/ReviewWorkspace.tsx`; create `components/ThreadsPanel.tsx`, `components/RereviewBanner.tsx`; test `components/ThreadsPanel.test.tsx` (renderSlot-style where feasible) + build-verify.

Use relative imports and host token classes (match existing components). `useRpc<typeof rpcContract>()`.

- [ ] **Step 1: ReviewHeader — CI badge + reviewDecision.** Accept a `checks` prop (`{bucket, checks}`) and render a small badge: `pass`→`text-foreground`/✓, `fail`→`text-destructive`, `pending`→`text-muted-foreground`. Show count `(${checks.length})`. (ReviewWorkspace fetches checks and passes them in.)

- [ ] **Step 2: ChapterNav — risk badge.** When `s.risk`, render a pill next to the title: `high`→`text-destructive border-destructive`, `medium`→muted, `low`→muted; label the risk. Keep existing layout.

- [ ] **Step 3: `components/RereviewBanner.tsx`.** Props `{ targetKey }`. On mount call `checkForUpdates`; if `hasNewCommits`, render a banner ("New commits on this PR since the guide was built") with a **Re-review** button that calls `rereview({targetKey})` then toasts and relies on the `review:<key>` realtime signal to refresh. Also expose the Re-review button unconditionally (small) so a user can force it.

- [ ] **Step 4: `components/ThreadsPanel.tsx`.** Props `{ targetKey }`. On mount call `getReviewThreads`; render each thread (path:line, resolved/outdated state, its comments), a reply textarea (calls `replyToThread({targetKey, inReplyTo: thread.comments[0].databaseId, body})`), and a Resolve/Unresolve button (`resolveThread`/`unresolveThread`). Refetch after each action. Empty state when no threads (or non-PR target).

- [ ] **Step 5: Wire into `ReviewWorkspace.tsx`.** Fetch `getChecks` (pass to ReviewHeader) alongside the existing loads. Add `<RereviewBanner targetKey=… />` under the header. Add a toggle/tab in the right pane (or below the diff) to show `<ThreadsPanel targetKey=… />`. Keep the chapter/diff/draft flow intact.

- [ ] **Step 6: Verify** — `npx tsc --noEmit` clean, `npm test` green (add at least a ThreadsPanel render test with mocked rpc returning one thread and asserting a reply call), `bb plugin build` succeeds. Commit: `feat: CI badge, risk badges, threads panel, re-review banner`.

---

## Task 6: Integration verify + docs

- [ ] Full `npm test` + `npx tsc --noEmit` + `bb plugin build` + `bb plugin reload guided-review`.
- [ ] Update `README.md`: move the Phase 2 items from "Roadmap" to features; note thread reply/resolve, CI, risk flags, re-review.
- [ ] Update the spec §11: mark Phase 2 delivered.
- [ ] Commit: `docs: phase 2 complete`.

## Self-Review (against spec §11)
- Reply/resolve threads → Tasks 1,3,5. CI status → Tasks 1,3,5. Risk flags → Tasks 4,5. Re-review on new commits → Tasks 2,3,5. gitRef fix → Task 4. ✓
- No placeholder steps; new store columns are append-only; every new rpc has `.strict()` input and a test; gh GraphQL args carry the query + `-F` vars.
- Types: `ReviewMeta.headSha/cwd`, `ChecksSummary`, `ReviewThread` used consistently across tasks.
