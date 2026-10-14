# Guided Review — Design Spec

**Date:** 2026-08-24
**Status:** Shipped by 0.1 (both phases). Historical; README and DESIGN.md describe the plugin as it is.
**Plugin id:** `guided-review` · **Command:** `bb review <pr-url | pr-number | git-ref>`
**Stack:** TypeScript backend (`bb.server`) + React/Tailwind panel (`bb.app`)

---

## 1. Summary

Guided Review is a bb plugin that turns a GitHub pull request (or a local git
ref) into an ordered, chaptered walkthrough — a "guide" — authored by a bb
agent, rendered in a live bb panel, and reviewable end to end. Unlike GitHub's
flat file list, the PR arrives as a *story*: implementation heart first,
consequences next, glue/config last. The reviewer reads the chapters, browses
syntax-highlighted diffs, asks the agent questions inline, drafts comments, and
submits the whole thing back to the real GitHub PR as one batched review
(Approve / Request changes / Comment).

It is inspired by [plannotator/guides](https://github.com/plannotator/guides)
(the "guided review" concept and its `guide.json` shape) but is native to bb:
the generation engine is a bb agent, the viewer is a bb panel, and it writes
back to GitHub — no external CLI and no upload to a third-party host.

## 2. Goals / Non-goals

### Goals
- One command (`bb review <target>`) produces a chaptered guide and opens it in a panel.
- Native bb agent generates the guide from the diff (no external `plannotator` CLI).
- Reviewer can leave per-line and per-chapter comments into a draft review.
- Reviewer can ask the agent inline while reviewing ("explain", "assess risk", "draft a comment").
- Submit posts back to the GitHub PR as a single review with a verdict.
- Works on a GitHub PR (URL or number, via `gh`) or a local git ref.

### Non-goals (this version)
- No self-hosted sharing service / encrypted `guides.show` clone. Local-ref HTML export is Phase 2.
- No replacing GitHub as the source of truth — we post *to* GitHub, we do not mirror it.
- No support for non-GitHub forges (GitLab/Bitbucket) in v1.

## 3. Prerequisites (verified 2026-08-24)
- `gh` CLI installed and authenticated with `repo` scope. Confirmed: `gh 2.95.0`, account `notpritamm`, scopes include `repo`.
- bb plugin toolchain (`bb plugin new/build/dev`) available.

## 4. Primary user flow

1. `bb review 1234` (PR number) — or a PR URL, or `bb review origin/main...HEAD` (local ref).
2. Backend resolves the target:
   - PR: `gh pr view` + `gh pr diff` → `guide.patch`, plus PR metadata (title, body, author, base, head, number, url).
   - Local ref: `git diff <ref>` → `guide.patch`, no `source.pr`.
3. Backend spawns a bb agent with the bundled generation prompt/skill. The agent
   reads `guide.patch` (authoritative file set) + PR title/body + `git log --oneline`,
   chunks the diff into ordered chapters, and calls the `generate_review_guide`
   agent tool to persist `guide.json`.
4. Backend validates coverage (every changed file in exactly one chapter's `diffs`
   or in `unplacedFiles`; never twice; never omitted). On failure it returns the
   error to the agent to fix and retry.
5. Panel opens: PR header + chapter navigator (left), diff viewer (right), draft tray (bottom).
6. Reviewer reads, comments, asks the agent, then **Submit review → Approve / Request changes / Comment**.
7. Backend posts one GitHub review via `gh api` with all draft line comments + the verdict body.

## 5. Architecture

Three bb-plugin bundles.

### 5.1 `bb.server` (backend, TypeScript)

**CLI command**
- `bb review <target> [--base <ref>]` — resolves target, builds `guide.patch`,
  gathers metadata, kicks off generation, opens the panel focused on this review.

**Agent tools** (native, scoped to this plugin's generation thread via `configure()`)
- `read_review_patch({ targetKey, offset?, limit? })` — returns the diff text
  (paginated) so the generation agent gets the patch through a tool rather than
  depending on file placement across hosts.
- `generate_review_guide({ targetKey, guide })` — the generation agent calls this
  to submit the guide it authored. Validates shape + coverage and returns errors
  for the agent to fix, or success (this is plannotator's "verify coverage" gate).

**RPC methods** (frontend data plane via `bb.rpc`; the panel calls these with `useRpc`)
| Method | Purpose | Backed by |
|--------|---------|-----------|
| `getGuide` | current guide.json | plugin db |
| `getPatch` | full patch (for `@pierre/diffs`) | patch file on dataDir |
| `getPr` | PR metadata | `gh pr view --json` |
| `getThreads` | existing review comments/threads (read) | `gh api .../comments` |
| `getChecks` | CI status | `gh pr checks` / `gh api` |
| `saveDraftComment` | add/update a draft comment | plugin db (`review-draft`) |
| `removeDraftComment` | remove a draft comment | plugin db |
| `submitReview` | post batched review + verdict | `gh api .../pulls/{n}/reviews` |
| `assist` | scoped agent turn (explain/assess/draft) | hidden bb thread |

GitHub-touching methods shell out to `gh` (no raw token handling in the plugin).
`bb.http` is reserved for external callers/webhooks and is unused in Phase 1.

### 5.2 `bb.app` (frontend panel, React + Tailwind)

Component tree:
- `ReviewHeader` — title, author, `base ← head`, CI badge, verdict selector.
- `ChapterNav` — ordered chapters + `overview` snippet; "unplaced files"; coverage indicator.
- `DiffViewer` — renders the selected chapter's files. **Reuse a mature diff
  renderer** (`react-diff-view` or diff2html) for syntax highlighting, collapsing,
  and line gutters, rather than building a diff engine. Line gutters expose
  "add comment" and "ask agent".
- `DraftTray` — pending comments list + `Submit review` (Approve / Request changes / Comment).
- `AssistPopover` — inline agent answers ("explain this chapter", "is this safe?", "draft a comment").

Conventions per repo standards: functional components, `memo()` + `.displayName`,
`cn()` for conditional classes, CSS-variable/Tailwind tokens (no hardcoded colors),
`t()` for user-facing strings, and PostHog tracking on each new action with a
`location` identifier. Data access goes through the plugin backend routes — the
panel never talks to GitHub or the filesystem directly.

### 5.3 Generation

A bundled skill/prompt (shipped with the plugin) instructs a bb agent to author
the guide. The agent runs as a scoped bb turn/child thread; its only side effect
is calling `generate_review_guide`. This reuses plannotator's chunk-and-order
heuristic (heart → consequences → glue) but the engine is ours.

## 6. Data model

### 6.1 `guide.json` (extends plannotator's shape)

```jsonc
{
  "title": "one line",
  "intent": "1-2 sentences: why this change exists",
  "sections": [
    {
      "id": "refresh-loop",              // added: stable id for comment anchoring
      "title": "The refresh loop",
      "overview": "markdown, 2-6 sentences",
      "risk": "low",                     // added (Phase 2 populated): low|medium|high
      "diffs": [
        { "file": "src/auth/refresh.ts", "summary": "New: scheduler and waitForToken()." }
      ]
    }
  ],
  "unplacedFiles": [],
  "review": { "gitRef": "origin/main...HEAD", "base": "origin/main" },
  "source": {                            // added: absent for local-ref mode
    "kind": "pr",
    "pr": { "url": "...", "number": 1234, "title": "...", "author": "...", "base": "main", "head": "feature" }
  },
  "generator": { "engine": "claude-code", "model": "..." }
}
```

### 6.2 `review-draft.json`

```jsonc
{
  "target": { "kind": "pr", "number": 1234 },
  "verdict": "COMMENT",                  // APPROVE | REQUEST_CHANGES | COMMENT
  "body": "top-level review summary",
  "comments": [
    { "file": "src/auth/refresh.ts", "line": 42, "side": "RIGHT", "chapterId": "refresh-loop", "body": "..." }
  ]
}
```

## 7. GitHub sync (post-back)

Draft comments accumulate locally; on submit we post **one** review so the PR
gets a single coherent review, matching GitHub's native "start a review → submit":

```bash
gh api -X POST repos/{owner}/{repo}/pulls/{number}/reviews \
  -f event=APPROVE \
  -f body='<summary>' \
  -F 'comments[][path]=src/auth/refresh.ts' -F 'comments[][line]=42' \
  -F 'comments[][side]=RIGHT' -F 'comments[][body]=...'
```

Reading context (title/body, existing threads, CI checks) is read-only in
Phase 1. Reply/resolve of existing threads is Phase 2.

## 8. Storage
- Per-thread storage dir (`$BB_THREAD_STORAGE`), keyed by target (PR number or ref hash):
  `guide.json`, `guide.patch`, `review-draft.json`.
- Re-running `bb review` on the same target resumes the in-progress draft instead of discarding it.

## 9. Error handling
- `gh` missing/unauthed → panel shows an actionable message (how to `gh auth login`), no crash.
- Generation/validation failure → coverage error surfaced to the agent for retry; if it
  still fails, the panel shows the raw diff with a "generate failed, retry" affordance so
  the reviewer is never blocked.
- Submit failure (e.g. can't approve own PR, stale head) → error surfaced with the `gh` message; draft is preserved.
- All user-facing errors also go through `noticeError()` monitoring, never `console.error` alone.

## 10. Testing
- **Unit:** guide schema + coverage validator; `gh` command builders (pure functions, `gh` mocked); diff parsing.
- **Component:** panel against fixture guides (chapters render, comment add/remove, verdict select).
- **End-to-end:** one run against a throwaway test PR in a scratch repo (generate → comment → submit → verify on GitHub).

## 11. Phasing

### Phase 1 (MVP — ships, already beats a flat PR view)
- `bb review <pr|ref>` → agent-generated guide → panel (chapters + diffs).
- Per-line and per-chapter draft comments.
- **Inline agent-assist** (explain / assess / draft a comment).
- Submit as a batched GitHub review (Approve / Request changes / Comment).
- Read PR title/body + existing comments + CI status (read-only).

### Phase 2 (best-in-class) — DELIVERED (2026-08-26)
- ✅ Reply to and resolve existing PR review threads (GraphQL review threads + resolve/unresolve).
- ✅ CI status surfaced in the panel header (`gh pr checks --json`).
- ✅ Chapter risk flags populated by the generation agent.
- ✅ Re-review on new commits (head-SHA comparison; one-click re-run of the review).
- ✅ Authoritative `guide.review.gitRef` (stamped server-side).
- Deferred by choice: single-file HTML export + encrypted share links (guides.show-style).

## 12. Resolved decisions & assumptions
- **Diff renderer — RESOLVED:** use `@pierre/diffs` (`parsePatchFiles` + `FileDiff`
  from `@pierre/diffs/react`), shipped/shimmed by the SDK; renders exactly like bb's
  own diff panel. Synthesize `diff --git a/<p> b/<p>` headers when `gh` output omits
  them (same approach as the official `github` plugin).
- **Agent run mechanism — RESOLVED:** generation runs as a hidden bb thread
  (`bb.sdk.threads.spawn({ visibility: "hidden" })`), archived + stopped in a `finally`.
  The agent gets the diff and submits the guide through two native tools
  (`read_review_patch`, `generate_review_guide`) selected only for this plugin's own
  spawned thread via `bb.agents.configure` (gated on `context.origin.pluginId`).
- **Panel open — ASSUMPTION:** backend cannot force frontend navigation, so `bb review`
  prepares the review and prints "open the Guided Review panel"; the panel (a `navPanel`)
  lists reviews and the user opens the target. Auto-open is Phase 2.
- **Host — ASSUMPTION:** Phase 1 targets a single local machine (server host == local),
  so `gh`/`git` run server-local via `child_process`. Multi-host resolution
  (ctx.threadId → environment → hostId, run through that host) is Phase 2.
- **Multi-account `gh`:** two accounts are authed (`notpritamm` active). Use the active
  account; expose an override later if needed.
