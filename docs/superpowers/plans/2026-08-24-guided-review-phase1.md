# Guided Review — Phase 1 Implementation Plan

> **Status: shipped by 0.1. A historical record, not pending work: don't execute it.** README and DESIGN.md describe the plugin as it is.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a bb plugin that turns a GitHub PR (or local git ref) into an agent-authored chaptered walkthrough, rendered in a live bb panel, reviewable with per-line/chapter comments and inline agent-assist, and submittable back to the GitHub PR as one batched review.

**Architecture:** A single bb plugin with a TypeScript backend (`bb.server`) and a React panel (`bb.app`). The backend registers a `bb review` CLI command, an RPC data plane for the panel, two native agent tools + a bundled skill that drive guide generation in a hidden bb thread, and a SQLite-backed store. The panel (a `navPanel`) renders chapters + `@pierre/diffs` diffs, collects a draft review, and submits it via the `gh` CLI. All GitHub access is `gh` shelled out server-local; no raw token handling.

**Tech Stack:** TypeScript, `@get-bb/plugin-sdk` (backend + `/app` + `/testing`), Zod 4, React, Tailwind (host theme tokens), `@pierre/diffs`, vendored shadcn UI, `gh` CLI, `git`, vitest.

**Spec:** `docs/superpowers/specs/2026-08-24-guided-review-design.md`

## Global Constraints

- **Plugin id:** `guided-review` (package name `bb-plugin-guided-review`). CLI command name: `review`.
- **Frontend ↔ backend:** panel uses `bb.rpc` + `useRpc` only. Never `bb.http` (reserved for external callers; unused in Phase 1).
- **Diffs:** render with `@pierre/diffs` (`parsePatchFiles` + `FileDiff` from `@pierre/diffs/react`). Synthesize `diff --git a/<p> b/<p>` headers when `gh` omits them. `@pierre/diffs` is a devDependency (types only; runtime is host-shimmed).
- **GitHub:** all access via `gh` shelled server-local with `cwd` = repo dir. No token in code. Use the active `gh` account.
- **Generation flow (plannotator-exact, per user):** dump diff → read → chunk & order sections *implementation heart first, consequences next, glue/wiring/config in a trailing grouped chapter last* → write `title`/`intent`/each section's `overview` + `diffs` → verify coverage (every changed file in exactly one section's `diffs` or in `unplacedFiles`; never twice; never omitted) → submit. Never edit the patch to fit the guide.
- **guide.json shape:** `title`, `intent`, `sections[]` = `{ id, title, overview, risk?, diffs[] = { file, summary } }`, `unplacedFiles[]`, `review = { gitRef, base? }`, `source?`, `generator?`.
- **Storage:** plugin SQLite via `bb.storage.database()` + append-only `bb.storage.migrate`. Patches live in the DB (no 256KB kv cap). Migration statements are append-only — never reorder/edit shipped statements.
- **UI styling:** host token classes only (`bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, `text-destructive`, …). No hardcoded colors, no custom `@theme`, no `oklch(...)` literals. `toast` from `sonner`.
- **Host assumption (Phase 1):** single local machine (server host == local). `gh`/`git` run via `node:child_process`. Multi-host is Phase 2.
- **Panel open:** backend cannot navigate the frontend; `bb review` prints "open the Guided Review panel". The panel lists reviews; the user opens the target. Auto-open is Phase 2.

---

## File Structure

```
bb-plugin-guided-review/
  package.json                      # manifest: bb.server, bb.app, bb.skills, deps
  server.ts                         # factory: wires store, cli, rpc, tools, configure, realtime
  app.tsx                           # definePluginApp: navPanel "Review"
  vitest.config.ts                  # backend + jsdom projects
  src/
    targets.ts                      # parseTarget, targetKey (pure)
    patch.ts                        # ensureGitHeaders, splitPatchByFile, changedFiles (pure)
    guide.ts                        # Zod schema, validateGuide, checkCoverage (pure)
    draft.ts                        # Draft types, toGithubReviewPayload (pure)
    gh.ts                           # gh/git arg builders (pure) + runGh/runGit (child_process)
    store.ts                        # createStore(bb): DB migrations + persistence
    generate.ts                     # generateGuide(): spawn hidden thread, wait, finalize
    assist.ts                       # runAssist(): scoped hidden thread → text
    rpc-contract.ts                 # Zod rpc contract (app imports its TYPE only)
  components/
    ReviewPanel.tsx                 # navPanel root; routes by subPath
    ReviewList.tsx                  # list of reviews
    ReviewWorkspace.tsx             # header + nav + diff + tray for one target
    ReviewHeader.tsx
    ChapterNav.tsx
    DiffViewer.tsx                  # @pierre/diffs
    DraftTray.tsx
    AssistPopover.tsx
    ui/                             # vendored shadcn (from scaffold + shadcn add)
  skills/
    guided-review-generate/SKILL.md # plannotator-exact generation instructions
  docs/superpowers/{specs,plans}/   # this plan + the spec
```

Test files are colocated as `src/<name>.test.ts` (backend) and `components/<name>.test.tsx` (frontend, `// @vitest-environment jsdom`).

---

## Task 1: Scaffold, install, and a smoke RPC

**Files:**
- Create (via scaffold): `package.json`, `server.ts`, `app.tsx`, `components/ui/*`, `components.json`, `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/rpc-contract.ts`
- Test: `src/smoke.test.ts`

**Interfaces:**
- Produces: `rpcContract` (Zod contract, extended in later tasks); a working `plugin` factory default-exported from `server.ts`.

- [ ] **Step 1: Scaffold into a temp dir and merge (preserves existing git + docs)**

The project dir already exists with `.git` and `docs/`. Scaffold elsewhere, copy in, keep our history:

```bash
cd /Volumes/X9/Dev
bb plugin new guided-review --app        # creates ./bb-plugin-guided-review OR fails if non-empty
```

If `bb plugin new` refuses because `bb-plugin-guided-review` is non-empty, scaffold to a temp name and merge:

```bash
cd /tmp && rm -rf gr-scaffold && mkdir gr-scaffold && cd gr-scaffold
bb plugin new guided-review --app
# copy everything except its .git into the real repo
rsync -a --exclude='.git' /tmp/gr-scaffold/bb-plugin-guided-review/ /Volumes/X9/Dev/bb-plugin-guided-review/
```

- [ ] **Step 2: Add dependencies**

```bash
cd /Volumes/X9/Dev/bb-plugin-guided-review
npm pkg set dependencies.zod="^4.0.0"
npm pkg set devDependencies.@pierre/diffs="*"
npm pkg set devDependencies.vitest="^3.0.0"
npm pkg set devDependencies.better-sqlite3="*"
npm pkg set devDependencies.jsdom="*"
npm pkg set devDependencies.@testing-library/react="*"
npm pkg set devDependencies.@testing-library/dom="*"
npm pkg set scripts.test="vitest run"
npm pkg set bb.skills[0]="skills"
npm install
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "backend", include: ["src/**/*.test.ts"], environment: "node" } },
      { test: { name: "frontend", include: ["components/**/*.test.tsx"], environment: "jsdom" } },
    ],
  },
});
```

- [ ] **Step 4: Create `src/rpc-contract.ts` with a smoke method**

```ts
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const rpcContract = defineRpcContract({
  ping: { input: z.null(), output: z.object({ ok: z.boolean() }) },
});
```

- [ ] **Step 5: Replace `server.ts` with a minimal factory that registers the contract**

```ts
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./src/rpc-contract";

export { rpcContract } from "./src/rpc-contract";

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    ping() {
      return { ok: true };
    },
  });
}
```

- [ ] **Step 6: Write the smoke test**

```ts
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

test("ping returns ok", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const res = await harness.behavior.callRpc("ping", null);
  expect(res).toEqual({ ok: true });
});
```

- [ ] **Step 7: Run the test, expect PASS**

Run: `npm test -- src/smoke.test.ts`
Expected: PASS.

- [ ] **Step 8: Install into the running bb and confirm it loads**

```bash
bb plugin install . --yes
bb plugin list | grep guided-review        # status should be running
```

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "chore: scaffold guided-review plugin + smoke rpc"
```

---

## Task 2: Target parsing (`src/targets.ts`)

**Files:**
- Create: `src/targets.ts`
- Test: `src/targets.test.ts`

**Interfaces:**
- Produces:
  - `type ReviewTarget = { kind: "pr"; number: number; repo?: string } | { kind: "ref"; gitRef: string; base?: string }`
  - `parseTarget(input: string, base?: string): ReviewTarget`
  - `targetKey(t: ReviewTarget): string`

- [ ] **Step 1: Write the failing test**

```ts
import { parseTarget, targetKey } from "./targets";

test("parses a PR url", () => {
  expect(parseTarget("https://github.com/acme/web/pull/1234")).toEqual({
    kind: "pr", number: 1234, repo: "acme/web",
  });
});

test("parses a bare PR number", () => {
  expect(parseTarget("1234")).toEqual({ kind: "pr", number: 1234 });
});

test("parses a range ref", () => {
  expect(parseTarget("origin/main...HEAD")).toEqual({ kind: "ref", gitRef: "origin/main...HEAD" });
});

test("parses a branch ref with base", () => {
  expect(parseTarget("feature/x", "main")).toEqual({ kind: "ref", gitRef: "feature/x", base: "main" });
});

test("targetKey is stable and kind-prefixed", () => {
  expect(targetKey({ kind: "pr", number: 1234 })).toBe("pr-1234");
  const a = targetKey({ kind: "ref", gitRef: "feature/x", base: "main" });
  const b = targetKey({ kind: "ref", gitRef: "feature/x", base: "main" });
  expect(a).toBe(b);
  expect(a.startsWith("ref-")).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/targets.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import { createHash } from "node:crypto";

export type ReviewTarget =
  | { kind: "pr"; number: number; repo?: string }
  | { kind: "ref"; gitRef: string; base?: string };

const PR_URL = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;

export function parseTarget(input: string, base?: string): ReviewTarget {
  const trimmed = input.trim();
  const url = trimmed.match(PR_URL);
  if (url) return { kind: "pr", number: Number(url[2]), repo: url[1] };
  if (/^\d+$/.test(trimmed)) return { kind: "pr", number: Number(trimmed) };
  return base ? { kind: "ref", gitRef: trimmed, base } : { kind: "ref", gitRef: trimmed };
}

export function targetKey(t: ReviewTarget): string {
  if (t.kind === "pr") return `pr-${t.number}`;
  const hash = createHash("sha1").update(`${t.gitRef}${t.base ?? ""}`).digest("hex").slice(0, 12);
  return `ref-${hash}`;
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npm test -- src/targets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/targets.ts src/targets.test.ts && git commit -m "feat: target parsing"
```

---

## Task 3: Patch utilities (`src/patch.ts`)

**Files:**
- Create: `src/patch.ts`
- Test: `src/patch.test.ts`

**Interfaces:**
- Produces:
  - `interface PatchFile { path: string; text: string }`
  - `ensureGitHeaders(patch: string): string`
  - `splitPatchByFile(patch: string): PatchFile[]`
  - `changedFiles(patch: string): string[]`

- [ ] **Step 1: Write the failing test**

```ts
import { ensureGitHeaders, splitPatchByFile, changedFiles } from "./patch";

const withHeader = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`;

const noHeader = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`;

test("ensureGitHeaders adds a missing diff --git line", () => {
  expect(ensureGitHeaders(noHeader)).toContain("diff --git a/src/a.ts b/src/a.ts");
});

test("ensureGitHeaders leaves an existing header untouched", () => {
  expect(ensureGitHeaders(withHeader)).toBe(withHeader);
});

test("changedFiles lists repo-relative paths", () => {
  const two = withHeader + `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-x
+y
`;
  expect(changedFiles(two)).toEqual(["src/a.ts", "src/b.ts"]);
});

test("splitPatchByFile returns one entry per file with its own header", () => {
  const files = splitPatchByFile(withHeader);
  expect(files).toHaveLength(1);
  expect(files[0].path).toBe("src/a.ts");
  expect(files[0].text).toContain("diff --git a/src/a.ts");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/patch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export interface PatchFile { path: string; text: string }

// Ensure each file block has a "diff --git a/<p> b/<p>" header. Real git/gh
// diffs already have one (with an `index ...` line before `--- a/...`); only
// header-less inputs need synthesis. Track header-presence per file block, not
// by the single previous output line (a naive prev-line check duplicates the
// header on any diff that has an `index`/`mode` line before `--- a/...`).
export function ensureGitHeaders(patch: string): string {
  const lines = patch.split("\n");
  const out: string[] = [];
  let hasHeader = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      hasHeader = true;
      out.push(line);
      continue;
    }
    const minus = line.match(/^--- a\/(.+?)\r?$/); // old-file marker, CRLF-tolerant
    if (minus) {
      if (!hasHeader) out.push(`diff --git a/${minus[1]} b/${minus[1]}`);
      out.push(line);
      hasHeader = false; // next file block starts fresh
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export function splitPatchByFile(patch: string): PatchFile[] {
  const normalized = ensureGitHeaders(patch);
  const chunks = normalized.split(/\n(?=diff --git )/g).filter((c) => c.startsWith("diff --git "));
  return chunks.map((text) => {
    const m = text.match(/^diff --git a\/(.+?) b\//);
    return { path: m ? m[1] : "", text: text.endsWith("\n") ? text : text + "\n" };
  });
}

export function changedFiles(patch: string): string[] {
  return splitPatchByFile(patch).map((f) => f.path).filter(Boolean);
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npm test -- src/patch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/patch.ts src/patch.test.ts && git commit -m "feat: patch utilities"
```

---

## Task 4: Guide schema, validation & coverage (`src/guide.ts`)

**Files:**
- Create: `src/guide.ts`
- Test: `src/guide.test.ts`

**Interfaces:**
- Produces:
  - `type Guide` (inferred from Zod)
  - `validateGuide(raw: unknown): { ok: true; guide: Guide } | { ok: false; errors: string[] }`
  - `checkCoverage(guide: Guide, files: string[]): { ok: true } | { ok: false; errors: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
import { validateGuide, checkCoverage } from "./guide";

const good = {
  title: "T", intent: "I",
  sections: [{ id: "s1", title: "Sec", overview: "O", diffs: [{ file: "a.ts", summary: "x" }] }],
  unplacedFiles: [],
  review: { gitRef: "main...HEAD" },
};

test("validateGuide accepts a well-formed guide", () => {
  const r = validateGuide(good);
  expect(r.ok).toBe(true);
});

test("validateGuide rejects a missing title", () => {
  const r = validateGuide({ ...good, title: undefined });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(" ")).toMatch(/title/);
});

test("checkCoverage passes when every file is placed exactly once", () => {
  const r = checkCoverage(good as any, ["a.ts"]);
  expect(r.ok).toBe(true);
});

test("checkCoverage flags omitted, extra, and duplicated files", () => {
  const dup = {
    ...good,
    sections: [
      { id: "s1", title: "A", overview: "o", diffs: [{ file: "a.ts", summary: "x" }] },
      { id: "s2", title: "B", overview: "o", diffs: [{ file: "a.ts", summary: "y" }] },
    ],
  };
  const r = checkCoverage(dup as any, ["a.ts", "b.ts"]);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    const msg = r.errors.join(" ");
    expect(msg).toMatch(/duplicate.*a\.ts/i);
    expect(msg).toMatch(/missing.*b\.ts/i);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/guide.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { z } from "zod";

export const DiffRefSchema = z.object({ file: z.string().min(1), summary: z.string().min(1) });
export const SectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  overview: z.string().min(1),
  risk: z.enum(["low", "medium", "high"]).optional(),
  diffs: z.array(DiffRefSchema),
});
export const GuideSchema = z.object({
  title: z.string().min(1),
  intent: z.string().min(1),
  sections: z.array(SectionSchema),
  unplacedFiles: z.array(z.string()),
  review: z.object({ gitRef: z.string().min(1), base: z.string().optional() }),
  source: z.unknown().optional(),
  generator: z.unknown().optional(),
});
export type Guide = z.infer<typeof GuideSchema>;

export function validateGuide(raw: unknown):
  | { ok: true; guide: Guide }
  | { ok: false; errors: string[] } {
  const parsed = GuideSchema.safeParse(raw);
  if (parsed.success) return { ok: true, guide: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}

export function checkCoverage(guide: Guide, files: string[]):
  | { ok: true }
  | { ok: false; errors: string[] } {
  const placed = new Map<string, number>();
  for (const s of guide.sections) for (const d of s.diffs) placed.set(d.file, (placed.get(d.file) ?? 0) + 1);
  for (const f of guide.unplacedFiles) placed.set(f, (placed.get(f) ?? 0) + 1);

  const errors: string[] = [];
  const fileSet = new Set(files);
  for (const [file, count] of placed) {
    if (!fileSet.has(file)) errors.push(`extra: ${file} is in the guide but not in the diff`);
    else if (count > 1) errors.push(`duplicate: ${file} appears ${count} times`);
  }
  for (const f of files) if (!placed.has(f)) errors.push(`missing: ${f} is in the diff but not in the guide`);
  return errors.length ? { ok: false, errors } : { ok: true };
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npm test -- src/guide.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/guide.ts src/guide.test.ts && git commit -m "feat: guide schema, validation, coverage"
```

---

## Task 5: Draft → GitHub review payload (`src/draft.ts`)

**Files:**
- Create: `src/draft.ts`
- Test: `src/draft.test.ts`

**Interfaces:**
- Produces:
  - `type Verdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT"`
  - `interface DraftComment { file: string; line: number; side: "LEFT" | "RIGHT"; chapterId?: string; body: string }`
  - `interface Draft { targetKey: string; verdict: Verdict; body: string; comments: DraftComment[] }`
  - `toGithubReviewPayload(draft: Draft): { event: Verdict; body: string; comments: { path: string; line: number; side: string; body: string }[] }`

- [ ] **Step 1: Write the failing test**

```ts
import { toGithubReviewPayload, type Draft } from "./draft";

const draft: Draft = {
  targetKey: "pr-1",
  verdict: "REQUEST_CHANGES",
  body: "Overall looks close.",
  comments: [{ file: "src/a.ts", line: 42, side: "RIGHT", chapterId: "s1", body: "rename this" }],
};

test("maps a draft to the gh reviews API body", () => {
  expect(toGithubReviewPayload(draft)).toEqual({
    event: "REQUEST_CHANGES",
    body: "Overall looks close.",
    comments: [{ path: "src/a.ts", line: 42, side: "RIGHT", body: "rename this" }],
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/draft.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export type Verdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface DraftComment {
  file: string;
  line: number;
  side: "LEFT" | "RIGHT";
  chapterId?: string;
  body: string;
}

export interface Draft {
  targetKey: string;
  verdict: Verdict;
  body: string;
  comments: DraftComment[];
}

export function toGithubReviewPayload(draft: Draft): {
  event: Verdict;
  body: string;
  comments: { path: string; line: number; side: string; body: string }[];
} {
  return {
    event: draft.verdict,
    body: draft.body,
    comments: draft.comments.map((c) => ({ path: c.file, line: c.line, side: c.side, body: c.body })),
  };
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npm test -- src/draft.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/draft.ts src/draft.test.ts && git commit -m "feat: draft to github review payload"
```

---

## Task 6: `gh`/`git` command builders + runners (`src/gh.ts`)

**Files:**
- Create: `src/gh.ts`
- Test: `src/gh.test.ts`

**Interfaces:**
- Produces (pure builders):
  - `ghPrViewArgs(number: number, repo?: string): string[]`
  - `ghPrDiffArgs(number: number, repo?: string): string[]`
  - `ghRepoViewArgs(): string[]`
  - `ghPrCommentsArgs(repo: string, number: number): string[]`
  - `ghPrChecksArgs(number: number, repo?: string): string[]`
  - `ghSubmitReviewArgs(repo: string, number: number): string[]`
  - `gitDiffArgs(gitRef: string, base?: string): string[]`
- Produces (runners): `runGh(args, opts?): Promise<{ stdout; stderr; code }>`, `runGit(args, opts?)` — same shape; `opts = { cwd?: string; stdin?: string }`.

- [ ] **Step 1: Write the failing test (builders only; runners covered by integration)**

```ts
import {
  ghPrViewArgs, ghPrDiffArgs, ghRepoViewArgs, ghSubmitReviewArgs, gitDiffArgs,
} from "./gh";

test("pr view requests the json fields we need, with optional -R", () => {
  expect(ghPrViewArgs(12)).toEqual([
    "pr", "view", "12", "--json", "number,title,body,author,baseRefName,headRefName,url",
  ]);
  expect(ghPrViewArgs(12, "acme/web")).toContain("-R");
});

test("pr diff targets the number", () => {
  expect(ghPrDiffArgs(12)).toEqual(["pr", "diff", "12"]);
});

test("repo view returns nameWithOwner", () => {
  expect(ghRepoViewArgs()).toEqual(["repo", "view", "--json", "nameWithOwner"]);
});

test("submit review posts to the reviews endpoint reading json from stdin", () => {
  expect(ghSubmitReviewArgs("acme/web", 12)).toEqual([
    "api", "-X", "POST", "repos/acme/web/pulls/12/reviews", "--input", "-",
  ]);
});

test("git diff builds a range", () => {
  expect(gitDiffArgs("feature/x", "main")).toEqual(["diff", "main...feature/x"]);
  expect(gitDiffArgs("main...HEAD")).toEqual(["diff", "main...HEAD"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/gh.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { spawn } from "node:child_process";

const PR_FIELDS = "number,title,body,author,baseRefName,headRefName,url";

export function ghPrViewArgs(number: number, repo?: string): string[] {
  const a = ["pr", "view", String(number), "--json", PR_FIELDS];
  return repo ? [...a, "-R", repo] : a;
}
export function ghPrDiffArgs(number: number, repo?: string): string[] {
  const a = ["pr", "diff", String(number)];
  return repo ? [...a, "-R", repo] : a;
}
export function ghRepoViewArgs(): string[] {
  return ["repo", "view", "--json", "nameWithOwner"];
}
export function ghPrCommentsArgs(repo: string, number: number): string[] {
  return ["api", `repos/${repo}/pulls/${number}/comments`];
}
export function ghPrChecksArgs(number: number, repo?: string): string[] {
  const a = ["pr", "checks", String(number)];
  return repo ? [...a, "-R", repo] : a;
}
export function ghSubmitReviewArgs(repo: string, number: number): string[] {
  return ["api", "-X", "POST", `repos/${repo}/pulls/${number}/reviews`, "--input", "-"];
}
export function gitDiffArgs(gitRef: string, base?: string): string[] {
  if (gitRef.includes("..")) return ["diff", gitRef];
  return base ? ["diff", `${base}...${gitRef}`] : ["diff", gitRef];
}

interface RunOpts { cwd?: string; stdin?: string }
interface RunResult { stdout: string; stderr: string; code: number }

function run(bin: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

export const runGh = (args: string[], opts?: RunOpts) => run("gh", args, opts);
export const runGit = (args: string[], opts?: RunOpts) => run("git", args, opts);
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npm test -- src/gh.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gh.ts src/gh.test.ts && git commit -m "feat: gh/git command builders and runners"
```

---

## Task 7: Store (`src/store.ts`)

**Files:**
- Create: `src/store.ts`
- Test: `src/store.test.ts`

**Interfaces:**
- Consumes: `Guide` (Task 4), `Draft`/`DraftComment`/`Verdict` (Task 5).
- Produces:
  - `interface ReviewMeta { targetKey: string; kind: "pr" | "ref"; number?: number; repo?: string; title?: string; author?: string; base?: string; head?: string; gitRef?: string; url?: string; status: "generating" | "ready" | "error"; createdAt: number }`
  - `interface Store { saveReview; getReview; listReviews; savePatch; readPatch; setStatus; saveGuide; getGuide; getDraft; upsertDraftComment; removeDraftComment; setVerdict }`
  - `createStore(bb: BbPluginApi): Store`
- Exact method signatures:
  - `saveReview(meta: ReviewMeta): void`
  - `getReview(targetKey: string): ReviewMeta | null`
  - `listReviews(): ReviewMeta[]`  (newest first)
  - `setStatus(targetKey: string, status: ReviewMeta["status"]): void`
  - `savePatch(targetKey: string, patch: string): void`
  - `readPatch(targetKey: string, offset?: number, limit?: number): { text: string; total: number }`
  - `saveGuide(targetKey: string, guide: Guide): void`
  - `getGuide(targetKey: string): Guide | null`
  - `getDraft(targetKey: string): Draft`  (creates default `{ verdict: "COMMENT", body: "", comments: [] }`)
  - `upsertDraftComment(targetKey: string, c: DraftComment): Draft`  (dedupe by `file+line+side`)
  - `removeDraftComment(targetKey: string, index: number): Draft`
  - `setVerdict(targetKey: string, verdict: Verdict, body: string): Draft`

- [ ] **Step 1: Write the failing test**

```ts
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./store";

function store() {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  return createStore(bb);
}

test("review round-trips and lists newest first", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1 });
  s.saveReview({ targetKey: "pr-2", kind: "pr", number: 2, status: "generating", createdAt: 2 });
  expect(s.getReview("pr-1")?.number).toBe(1);
  expect(s.listReviews().map((r) => r.targetKey)).toEqual(["pr-2", "pr-1"]);
});

test("patch paginates", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "generating", createdAt: 1 });
  s.savePatch("pr-1", "abcdef");
  expect(s.readPatch("pr-1", 0, 3)).toEqual({ text: "abc", total: 6 });
  expect(s.readPatch("pr-1", 3, 10)).toEqual({ text: "def", total: 6 });
});

test("draft comments upsert and delete", () => {
  const s = store();
  s.saveReview({ targetKey: "pr-1", kind: "pr", number: 1, status: "ready", createdAt: 1 });
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "x" });
  s.upsertDraftComment("pr-1", { file: "a.ts", line: 1, side: "RIGHT", body: "updated" });
  let d = s.getDraft("pr-1");
  expect(d.comments).toHaveLength(1);
  expect(d.comments[0].body).toBe("updated");
  d = s.removeDraftComment("pr-1", 0);
  expect(d.comments).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Guide } from "./guide";
import type { Draft, DraftComment, Verdict } from "./draft";

export interface ReviewMeta {
  targetKey: string;
  kind: "pr" | "ref";
  number?: number;
  repo?: string;
  title?: string;
  author?: string;
  base?: string;
  head?: string;
  gitRef?: string;
  url?: string;
  status: "generating" | "ready" | "error";
  createdAt: number;
}

export interface Store {
  saveReview(meta: ReviewMeta): void;
  getReview(targetKey: string): ReviewMeta | null;
  listReviews(): ReviewMeta[];
  setStatus(targetKey: string, status: ReviewMeta["status"]): void;
  savePatch(targetKey: string, patch: string): void;
  readPatch(targetKey: string, offset?: number, limit?: number): { text: string; total: number };
  saveGuide(targetKey: string, guide: Guide): void;
  getGuide(targetKey: string): Guide | null;
  getDraft(targetKey: string): Draft;
  upsertDraftComment(targetKey: string, c: DraftComment): Draft;
  removeDraftComment(targetKey: string, index: number): Draft;
  setVerdict(targetKey: string, verdict: Verdict, body: string): Draft;
}

export function createStore(bb: BbPluginApi): Store {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS reviews (
      target_key TEXT PRIMARY KEY, kind TEXT NOT NULL, number INTEGER, repo TEXT,
      title TEXT, author TEXT, base TEXT, head TEXT, git_ref TEXT, url TEXT,
      status TEXT NOT NULL, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS patches (target_key TEXT PRIMARY KEY, patch TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS guides (target_key TEXT PRIMARY KEY, guide TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS drafts (target_key TEXT PRIMARY KEY, verdict TEXT NOT NULL, body TEXT NOT NULL, comments TEXT NOT NULL)`,
  ]);

  const rowToMeta = (r: any): ReviewMeta => ({
    targetKey: r.target_key, kind: r.kind, number: r.number ?? undefined, repo: r.repo ?? undefined,
    title: r.title ?? undefined, author: r.author ?? undefined, base: r.base ?? undefined,
    head: r.head ?? undefined, gitRef: r.git_ref ?? undefined, url: r.url ?? undefined,
    status: r.status, createdAt: r.created_at,
  });

  return {
    saveReview(m) {
      db.prepare(
        `INSERT INTO reviews (target_key,kind,number,repo,title,author,base,head,git_ref,url,status,created_at)
         VALUES (@targetKey,@kind,@number,@repo,@title,@author,@base,@head,@gitRef,@url,@status,@createdAt)
         ON CONFLICT(target_key) DO UPDATE SET
           kind=@kind,number=@number,repo=@repo,title=@title,author=@author,base=@base,head=@head,
           git_ref=@gitRef,url=@url,status=@status,created_at=@createdAt`,
      ).run({
        targetKey: m.targetKey, kind: m.kind, number: m.number ?? null, repo: m.repo ?? null,
        title: m.title ?? null, author: m.author ?? null, base: m.base ?? null, head: m.head ?? null,
        gitRef: m.gitRef ?? null, url: m.url ?? null, status: m.status, createdAt: m.createdAt,
      });
    },
    getReview(k) {
      const r = db.prepare(`SELECT * FROM reviews WHERE target_key=?`).get(k);
      return r ? rowToMeta(r) : null;
    },
    listReviews() {
      return db.prepare(`SELECT * FROM reviews ORDER BY created_at DESC`).all().map(rowToMeta);
    },
    setStatus(k, status) {
      db.prepare(`UPDATE reviews SET status=? WHERE target_key=?`).run(status, k);
    },
    savePatch(k, patch) {
      db.prepare(
        `INSERT INTO patches (target_key,patch) VALUES (?,?)
         ON CONFLICT(target_key) DO UPDATE SET patch=excluded.patch`,
      ).run(k, patch);
    },
    readPatch(k, offset = 0, limit = 200_000) {
      const row: any = db.prepare(`SELECT patch FROM patches WHERE target_key=?`).get(k);
      const text = row?.patch ?? "";
      return { text: text.slice(offset, offset + limit), total: text.length };
    },
    saveGuide(k, guide) {
      db.prepare(
        `INSERT INTO guides (target_key,guide) VALUES (?,?)
         ON CONFLICT(target_key) DO UPDATE SET guide=excluded.guide`,
      ).run(k, JSON.stringify(guide));
    },
    getGuide(k) {
      const row: any = db.prepare(`SELECT guide FROM guides WHERE target_key=?`).get(k);
      return row ? (JSON.parse(row.guide) as Guide) : null;
    },
    getDraft(k) {
      const row: any = db.prepare(`SELECT * FROM drafts WHERE target_key=?`).get(k);
      if (!row) return { targetKey: k, verdict: "COMMENT", body: "", comments: [] };
      return { targetKey: k, verdict: row.verdict, body: row.body, comments: JSON.parse(row.comments) };
    },
    upsertDraftComment(k, c) {
      const d = this.getDraft(k);
      const i = d.comments.findIndex((x) => x.file === c.file && x.line === c.line && x.side === c.side);
      if (i >= 0) d.comments[i] = c; else d.comments.push(c);
      writeDraft(db, d);
      return d;
    },
    removeDraftComment(k, index) {
      const d = this.getDraft(k);
      d.comments.splice(index, 1);
      writeDraft(db, d);
      return d;
    },
    setVerdict(k, verdict, body) {
      const d = this.getDraft(k);
      d.verdict = verdict; d.body = body;
      writeDraft(db, d);
      return d;
    },
  };
}

function writeDraft(db: any, d: Draft) {
  db.prepare(
    `INSERT INTO drafts (target_key,verdict,body,comments) VALUES (?,?,?,?)
     ON CONFLICT(target_key) DO UPDATE SET verdict=excluded.verdict,body=excluded.body,comments=excluded.comments`,
  ).run(d.targetKey, d.verdict, d.body, JSON.stringify(d.comments));
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npm test -- src/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts src/store.test.ts && git commit -m "feat: sqlite store"
```

---

## Task 8: Generation — skill + native tools + `generate.ts`

**Files:**
- Create: `skills/guided-review-generate/SKILL.md`
- Create: `src/generate.ts`
- Modify: `server.ts` (register the two tools + `configure` gating; call `createStore` once)
- Test: `src/generate.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 7), `changedFiles` (Task 3), `validateGuide`/`checkCoverage` (Task 4).
- Produces:
  - Native tools `read_review_patch` and `generate_review_guide` (registered in `server.ts`).
  - `generateGuide(bb: BbPluginApi, store: Store, targetKey: string, projectId: string): Promise<void>` — spawns a hidden thread, waits for idle, sets final status, publishes realtime `review:<targetKey>`.
  - `buildGenerationPrompt(targetKey: string): string`

- [ ] **Step 1: Write `skills/guided-review-generate/SKILL.md` (plannotator-exact flow)**

```markdown
---
name: guided-review-generate
description: Author a chaptered Guided Review of a diff for the guided-review plugin. The plugin injects the target key.
---

# Authoring a Guided Review

You are producing a **guide**: a chaptered walkthrough of a diff. Follow this exact flow.

1. **Read the diff.** Call `read_review_patch` with the provided `targetKey` (paginate with
   `offset`/`limit` until you have the whole patch). The patch is the authoritative file set.
2. **Chunk and order into sections.** Implementation heart first, its consequences next, and
   glue/wiring/config grouped into a trailing chapter last.
3. **Write** a one-line `title`, a 1–2 sentence `intent` (why the change exists), and for each
   section a concept-level `title`, a 2–6 sentence markdown `overview`, and its `diffs` — each
   `{ file, summary }` where `file` is the exact repo-relative path and `summary` is a 1–2
   sentence semantic description of that file's change. Give each section a short kebab-case `id`.
4. **Verify coverage.** Every changed file must appear in exactly one section's `diffs` OR in
   `unplacedFiles` — never twice, never omitted.
5. **Submit** by calling `generate_review_guide` with `{ targetKey, guide }`. If it returns
   coverage or validation errors, fix the guide and call it again. Never alter the diff to fit
   the guide.
```

- [ ] **Step 2: Write the failing test (tools + coverage gate)**

```ts
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

const patch = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
`;

async function host() {
  const h = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(h.bb);
  return h;
}

test("read_review_patch returns stored patch text", async () => {
  const { bb, harness } = await host();
  // seed a review + patch through the store the factory created:
  await harness.behavior.callRpc("__seedForTest", { targetKey: "pr-1", patch }); // helper rpc, Task 10 note
  const out = await harness.behavior.callAgentTool("read_review_patch", { targetKey: "pr-1" });
  expect(String(out.content?.[0]?.text ?? out)).toContain("diff --git a/a.ts");
});

test("generate_review_guide rejects incomplete coverage then accepts a full guide", async () => {
  const { harness } = await host();
  await harness.behavior.callRpc("__seedForTest", { targetKey: "pr-1", patch });

  const bad = await harness.behavior.callAgentTool("generate_review_guide", {
    targetKey: "pr-1",
    guide: { title: "T", intent: "I", sections: [], unplacedFiles: [], review: { gitRef: "x" } },
  });
  expect(bad.isError).toBe(true);

  const good = await harness.behavior.callAgentTool("generate_review_guide", {
    targetKey: "pr-1",
    guide: {
      title: "T", intent: "I",
      sections: [{ id: "s1", title: "S", overview: "o", diffs: [{ file: "a.ts", summary: "x" }] }],
      unplacedFiles: [], review: { gitRef: "x" },
    },
  });
  expect(good.isError).toBeFalsy();
});
```

> Note: `__seedForTest` is a tiny test-only RPC you add in Task 10's contract (guarded, no-op in prod is fine since it only writes store rows). If you prefer, seed by exposing `store` via a test export instead; keep whichever is simpler.

- [ ] **Step 3: Implement `src/generate.ts`**

```ts
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";

export function buildGenerationPrompt(targetKey: string): string {
  return [
    "Author a Guided Review for this change.",
    "Follow the guided-review-generate skill exactly.",
    `The target key is: ${targetKey}`,
    "Start by calling read_review_patch, then submit with generate_review_guide.",
  ].join("\n");
}

export async function generateGuide(
  bb: BbPluginApi,
  store: Store,
  targetKey: string,
  projectId: string,
): Promise<void> {
  // Finalize status + realtime signal on EVERY path: catch spawn/wait failure
  // so the review never gets stuck at "generating". Clean up only if a worker
  // was actually spawned.
  let workerId: string | undefined;
  try {
    const worker = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      prompt: buildGenerationPrompt(targetKey),
      title: `Generate guide: ${targetKey}`,
      visibility: "hidden",
    });
    workerId = worker.id;
    await bb.sdk.threads.wait({ threadId: worker.id, status: "idle" });
  } catch {
    // spawn/wait failed — fall through and finalize as error below
  } finally {
    if (workerId) {
      await bb.sdk.threads.archive({ threadId: workerId }).catch(() => {});
      await bb.sdk.threads.stop({ threadId: workerId }).catch(() => {});
    }
  }
  const ok = store.getGuide(targetKey) !== null;
  store.setStatus(targetKey, ok ? "ready" : "error");
  bb.realtime.publish(`review:${targetKey}`, { status: ok ? "ready" : "error" });
}
```

- [ ] **Step 4: Register the tools + configure gating in `server.ts`**

Add to the factory (after `const store = createStore(bb);`):

```ts
import { z } from "zod";
import { changedFiles } from "./src/patch";
import { validateGuide, checkCoverage } from "./src/guide";

bb.agents.registerTool({
  name: "read_review_patch",
  description: "Return the diff text for a Guided Review target (paginated).",
  parameters: z.object({
    targetKey: z.string(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200_000).optional(),
  }),
  async execute({ targetKey, offset, limit }) {
    const { text, total } = store.readPatch(targetKey, offset, limit);
    const end = (offset ?? 0) + text.length;
    const more = end < total ? `\n\n[${end}/${total} bytes — call again with offset=${end}]` : "";
    return text + more;
  },
});

bb.agents.registerTool({
  name: "generate_review_guide",
  description: "Submit the authored guide. Validates shape and coverage.",
  parameters: z.object({ targetKey: z.string(), guide: z.unknown() }),
  async execute({ targetKey, guide }) {
    const v = validateGuide(guide);
    if (!v.ok) return { content: [{ type: "text", text: "Invalid guide:\n" + v.errors.join("\n") }], isError: true };
    const files = changedFiles(store.readPatch(targetKey, 0, 5_000_000).text);
    const cov = checkCoverage(v.guide, files);
    if (!cov.ok) return { content: [{ type: "text", text: "Coverage errors:\n" + cov.errors.join("\n") }], isError: true };
    store.saveGuide(targetKey, v.guide);
    return "Guide accepted.";
  },
});

// Only expose these tools to THIS plugin's own spawned generation thread.
bb.agents.configure((context) =>
  context.origin?.pluginId === bb.pluginId
    ? { tools: ["read_review_patch", "generate_review_guide"], skills: ["guided-review-generate"] }
    : { tools: [] },
);
```

- [ ] **Step 5: Run the generation tests, expect PASS**

Run: `npm test -- src/generate.test.ts`
Expected: PASS (coverage gate returns `isError` then accepts).

- [ ] **Step 6: Commit**

```bash
git add skills src/generate.ts src/generate.test.ts server.ts && git commit -m "feat: generation skill, native tools, coverage gate"
```

---

## Task 9: `bb review` CLI command

**Files:**
- Create: `src/review-command.ts`
- Modify: `server.ts` (register `bb.cli`)
- Test: `src/review-command.test.ts`

**Interfaces:**
- Consumes: `parseTarget`/`targetKey` (Task 2), `ensureGitHeaders`/`changedFiles` (Task 3), `gh` builders + `runGh`/`runGit` (Task 6), `Store` (Task 7), `generateGuide` (Task 8).
- Produces: `runReviewCommand(deps, argv, ctx): Promise<{ exitCode: number; stdout?: string; stderr?: string }>` where `deps = { bb, store, gh: { runGh, runGit } }`, `ctx = { projectId?, threadId?, cwd? }`.

- [ ] **Step 1: Write the failing test (gh/git mocked via `vi.mock`)**

```ts
import { vi } from "vitest";
vi.mock("./gh", async (orig) => {
  const real = await orig<any>();
  return {
    ...real,
    runGh: vi.fn(async (args: string[]) => {
      if (args[0] === "repo") return { stdout: JSON.stringify({ nameWithOwner: "acme/web" }), stderr: "", code: 0 };
      if (args[1] === "view") return { stdout: JSON.stringify({ number: 7, title: "Fix", body: "b", author: { login: "a" }, baseRefName: "main", headRefName: "f", url: "u" }), stderr: "", code: 0 };
      if (args[1] === "diff") return { stdout: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-o\n+n\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }),
    runGit: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
  };
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./store";
import { runReviewCommand } from "./review-command";
import * as gh from "./gh";

test("bb review <number> fetches, stores patch+meta, and kicks generation", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "guided-review",
    sdk: { threads: { spawn: async () => ({ id: "th_1" }), wait: async () => {}, archive: async () => {}, stop: async () => {} } },
  });
  const store = createStore(bb);
  const res = await runReviewCommand({ bb, store, gh }, ["7"], { projectId: "p1", cwd: "/repo" });
  expect(res.exitCode).toBe(0);
  const meta = store.getReview("pr-7");
  expect(meta?.repo).toBe("acme/web");
  expect(store.readPatch("pr-7").text).toContain("diff --git a/a.ts");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/review-command.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/review-command.ts`**

```ts
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";
import { parseTarget, targetKey, type ReviewTarget } from "./targets";
import { ensureGitHeaders } from "./patch";
import { generateGuide } from "./generate";
import {
  ghPrViewArgs, ghPrDiffArgs, ghRepoViewArgs, gitDiffArgs,
} from "./gh";

interface Deps {
  bb: BbPluginApi;
  store: Store;
  gh: { runGh: typeof import("./gh").runGh; runGit: typeof import("./gh").runGit };
}
interface Ctx { projectId?: string; threadId?: string; cwd?: string }

export async function runReviewCommand(deps: Deps, argv: string[], ctx: Ctx) {
  const positional = argv.filter((a) => !a.startsWith("-"));
  const input = positional[0];
  if (!input) return { exitCode: 2, stderr: "usage: bb review <pr-url | pr-number | git-ref> [--base <ref>]" };
  if (!ctx.projectId) return { exitCode: 2, stderr: "Run `bb review` inside a project thread." };

  const baseIdx = argv.indexOf("--base");
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : undefined;
  const target = parseTarget(input, base);
  const key = targetKey(target);
  const cwd = ctx.cwd;
  const now = Date.now();

  let patch = "";
  const meta: any = { targetKey: key, kind: target.kind, status: "generating", createdAt: now };

  if (target.kind === "pr") {
    let repo = target.repo;
    if (!repo) {
      const r = await deps.gh.runGh(ghRepoViewArgs(), { cwd });
      if (r.code !== 0) return { exitCode: 1, stderr: ghError(r.stderr) };
      repo = JSON.parse(r.stdout).nameWithOwner as string;
    }
    const view = await deps.gh.runGh(ghPrViewArgs(target.number, repo), { cwd });
    if (view.code !== 0) return { exitCode: 1, stderr: ghError(view.stderr) };
    const pr = JSON.parse(view.stdout);
    Object.assign(meta, {
      number: target.number, repo, title: pr.title, author: pr.author?.login,
      base: pr.baseRefName, head: pr.headRefName, url: pr.url, gitRef: `${pr.baseRefName}...${pr.headRefName}`,
    });
    const diff = await deps.gh.runGh(ghPrDiffArgs(target.number, repo), { cwd });
    if (diff.code !== 0) return { exitCode: 1, stderr: ghError(diff.stderr) };
    patch = diff.stdout;
  } else {
    const diff = await deps.gh.runGit(gitDiffArgs(target.gitRef, target.base), { cwd });
    if (diff.code !== 0) return { exitCode: 1, stderr: diff.stderr || "git diff failed" };
    patch = diff.stdout;
    meta.gitRef = target.base ? `${target.base}...${target.gitRef}` : target.gitRef;
    meta.base = target.base;
  }

  if (!patch.trim()) return { exitCode: 1, stderr: "No changes found for that target." };

  deps.store.saveReview(meta);
  deps.store.savePatch(key, ensureGitHeaders(patch));

  // Fire-and-forget generation; the panel refetches on the realtime signal.
  void generateGuide(deps.bb, deps.store, key, ctx.projectId).catch(() => deps.store.setStatus(key, "error"));

  return {
    exitCode: 0,
    stdout: `Guided Review started for ${key}. Open the Guided Review panel to watch it build and review.`,
  };
}

function ghError(stderr: string): string {
  if (/gh auth login|not logged|authentication/i.test(stderr)) {
    return "GitHub CLI is not authenticated. Run `gh auth login` (needs `repo` scope), then retry.";
  }
  return stderr || "gh command failed";
}
```

- [ ] **Step 4: Register the CLI in `server.ts`**

```ts
import { runReviewCommand } from "./src/review-command";
import { runGh, runGit } from "./src/gh";

bb.cli.register({
  name: "review",
  summary: "Open a Guided Review of a GitHub PR or local git ref",
  commands: [{ name: "review", summary: "Review a PR or ref", usage: "bb review <pr-url | pr-number | git-ref> [--base <ref>]" }],
  async run(argv, ctx) {
    return runReviewCommand({ bb, store, gh: { runGh, runGit } }, argv, ctx);
  },
});
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `npm test -- src/review-command.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/review-command.ts src/review-command.test.ts server.ts && git commit -m "feat: bb review command"
```

---

## Task 10: RPC read data plane

**Files:**
- Modify: `src/rpc-contract.ts` (add read methods)
- Modify: `server.ts` (implement handlers)
- Test: `src/rpc-read.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 7), `gh` builders + runners (Task 6).
- Produces contract methods (all inputs `.strict()`):
  - `listReviews` → `{ reviews: ReviewMeta[] }`
  - `getReview({ targetKey })` → `{ review: ReviewMeta | null }`
  - `getGuide({ targetKey })` → `{ guide: Guide | null; status: string }`
  - `getPatch({ targetKey })` → `{ patch: string }`
  - `getPr({ targetKey })` → `{ pr: unknown | null }` (live `gh pr view`)
  - `getThreads({ targetKey })` → `{ comments: unknown[] }` (live `gh api …/comments`)
  - `getChecks({ targetKey })` → `{ checks: string }` (live `gh pr checks`, raw text)
  - `__seedForTest({ targetKey, patch })` → `{ ok: true }` (writes a minimal review + patch; test convenience)

- [ ] **Step 1: Write the failing test**

```ts
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

test("listReviews + getPatch round-trip through rpc", async () => {
  const { harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin((await import("../server")).default === plugin ? undefined as any : undefined as any); // no-op guard
});
```

> Replace the placeholder above with a real test once `plugin` is imported once at top; the intent:

```ts
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

test("seed then read", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  await harness.behavior.callRpc("__seedForTest", { targetKey: "pr-1", patch: "diff --git a/a.ts b/a.ts\n" });
  const list = await harness.behavior.callRpc("listReviews", null);
  expect(list.reviews.map((r: any) => r.targetKey)).toContain("pr-1");
  const p = await harness.behavior.callRpc("getPatch", { targetKey: "pr-1" });
  expect(p.patch).toContain("diff --git");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/rpc-read.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend `src/rpc-contract.ts`**

```ts
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const targetKey = z.object({ targetKey: z.string() }).strict();

export const rpcContract = defineRpcContract({
  ping: { input: z.null(), output: z.object({ ok: z.boolean() }) },
  __seedForTest: { input: z.object({ targetKey: z.string(), patch: z.string() }).strict(), output: z.object({ ok: z.boolean() }) },
  listReviews: { input: z.null(), output: z.object({ reviews: z.array(z.any()) }) },
  getReview: { input: targetKey, output: z.object({ review: z.any().nullable() }) },
  getGuide: { input: targetKey, output: z.object({ guide: z.any().nullable(), status: z.string() }) },
  getPatch: { input: targetKey, output: z.object({ patch: z.string() }) },
  getPr: { input: targetKey, output: z.object({ pr: z.any().nullable() }) },
  getThreads: { input: targetKey, output: z.object({ comments: z.array(z.any()) }) },
  getChecks: { input: targetKey, output: z.object({ checks: z.string() }) },
});
```

- [ ] **Step 4: Implement handlers in `server.ts`**

Replace the `bb.rpc.register` block with the full set (keep `ping`):

```ts
import { ghPrViewArgs, ghPrCommentsArgs, ghPrChecksArgs, runGh } from "./src/gh";

bb.rpc.register(rpcContract, {
  ping: () => ({ ok: true }),
  __seedForTest({ targetKey, patch }) {
    store.saveReview({ targetKey, kind: "pr", number: 1, repo: "acme/web", status: "ready", createdAt: Date.now() });
    store.savePatch(targetKey, patch);
    return { ok: true };
  },
  listReviews: () => ({ reviews: store.listReviews() }),
  getReview: ({ targetKey }) => ({ review: store.getReview(targetKey) }),
  getGuide: ({ targetKey }) => ({ guide: store.getGuide(targetKey), status: store.getReview(targetKey)?.status ?? "error" }),
  getPatch: ({ targetKey }) => ({ patch: store.readPatch(targetKey, 0, 5_000_000).text }),
  async getPr({ targetKey }) {
    const m = store.getReview(targetKey);
    if (!m || m.kind !== "pr" || !m.number) return { pr: null };
    const r = await runGh(ghPrViewArgs(m.number, m.repo));
    return { pr: r.code === 0 ? JSON.parse(r.stdout) : null };
  },
  async getThreads({ targetKey }) {
    const m = store.getReview(targetKey);
    if (!m || m.kind !== "pr" || !m.number || !m.repo) return { comments: [] };
    const r = await runGh(ghPrCommentsArgs(m.repo, m.number));
    return { comments: r.code === 0 ? JSON.parse(r.stdout) : [] };
  },
  async getChecks({ targetKey }) {
    const m = store.getReview(targetKey);
    if (!m || m.kind !== "pr" || !m.number) return { checks: "" };
    const r = await runGh(ghPrChecksArgs(m.number, m.repo));
    return { checks: r.stdout || r.stderr };
  },
});
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `npm test -- src/rpc-read.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/rpc-contract.ts src/rpc-read.test.ts server.ts && git commit -m "feat: rpc read data plane"
```

---

## Task 11: RPC draft + submit

**Files:**
- Modify: `src/rpc-contract.ts` (add mutating methods)
- Modify: `server.ts` (handlers)
- Test: `src/rpc-draft.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 7), `toGithubReviewPayload` (Task 5), `ghSubmitReviewArgs`/`runGh` (Task 6).
- Produces contract methods:
  - `saveDraftComment({ targetKey, comment })` → `{ draft: Draft }`
  - `removeDraftComment({ targetKey, index })` → `{ draft: Draft }`
  - `setVerdict({ targetKey, verdict, body })` → `{ draft: Draft }`
  - `getDraft({ targetKey })` → `{ draft: Draft }`
  - `submitReview({ targetKey })` → `{ ok: boolean; error?: string }`

- [ ] **Step 1: Write the failing test (gh submit mocked)**

```ts
import { vi } from "vitest";
const submit = vi.fn(async () => ({ stdout: "{}", stderr: "", code: 0 }));
vi.mock("./gh", async (o) => ({ ...(await o<any>()), runGh: (args: string[]) => (args.includes("reviews") ? submit(args as any) : ({ stdout: "", stderr: "", code: 0 })) }));

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

test("draft comment then submit builds a batched review", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  await harness.behavior.callRpc("__seedForTest", { targetKey: "pr-1", patch: "diff --git a/a.ts b/a.ts\n" });
  await harness.behavior.callRpc("saveDraftComment", { targetKey: "pr-1", comment: { file: "a.ts", line: 1, side: "RIGHT", body: "nit" } });
  await harness.behavior.callRpc("setVerdict", { targetKey: "pr-1", verdict: "COMMENT", body: "ok" });
  const res = await harness.behavior.callRpc("submitReview", { targetKey: "pr-1" });
  expect(res.ok).toBe(true);
  expect(submit).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/rpc-draft.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extend the contract**

```ts
const commentShape = z.object({
  file: z.string(), line: z.number().int(), side: z.enum(["LEFT", "RIGHT"]),
  chapterId: z.string().optional(), body: z.string().min(1),
}).strict();

// add to defineRpcContract({...}):
  getDraft: { input: targetKey, output: z.object({ draft: z.any() }) },
  saveDraftComment: { input: z.object({ targetKey: z.string(), comment: commentShape }).strict(), output: z.object({ draft: z.any() }) },
  removeDraftComment: { input: z.object({ targetKey: z.string(), index: z.number().int().min(0) }).strict(), output: z.object({ draft: z.any() }) },
  setVerdict: { input: z.object({ targetKey: z.string(), verdict: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]), body: z.string() }).strict(), output: z.object({ draft: z.any() }) },
  submitReview: { input: targetKey, output: z.object({ ok: z.boolean(), error: z.string().optional() }) },
```

- [ ] **Step 4: Implement handlers in `server.ts`**

```ts
import { toGithubReviewPayload } from "./src/draft";
import { ghSubmitReviewArgs } from "./src/gh";

  getDraft: ({ targetKey }) => ({ draft: store.getDraft(targetKey) }),
  saveDraftComment: ({ targetKey, comment }) => ({ draft: store.upsertDraftComment(targetKey, comment) }),
  removeDraftComment: ({ targetKey, index }) => ({ draft: store.removeDraftComment(targetKey, index) }),
  setVerdict: ({ targetKey, verdict, body }) => ({ draft: store.setVerdict(targetKey, verdict, body) }),
  async submitReview({ targetKey }) {
    const m = store.getReview(targetKey);
    if (!m || m.kind !== "pr" || !m.number || !m.repo) return { ok: false, error: "Submitting requires a GitHub PR target." };
    const payload = toGithubReviewPayload(store.getDraft(targetKey));
    const r = await runGh(ghSubmitReviewArgs(m.repo, m.number), { stdin: JSON.stringify(payload) });
    if (r.code !== 0) return { ok: false, error: r.stderr || "gh review submit failed" };
    return { ok: true };
  },
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `npm test -- src/rpc-draft.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/rpc-contract.ts src/rpc-draft.test.ts server.ts && git commit -m "feat: draft + submit rpc"
```

---

## Task 12: Inline agent-assist (`src/assist.ts` + rpc)

**Files:**
- Create: `src/assist.ts`
- Modify: `src/rpc-contract.ts` + `server.ts`
- Test: `src/assist.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 7).
- Produces:
  - `runAssist(bb, store, { targetKey, chapterId?, file?, question, projectId }): Promise<{ answer: string }>` — spawns a hidden thread seeded with the relevant diff + guide context, waits idle, returns its output, archives+stops.
  - rpc `assist({ targetKey, chapterId?, file?, question })` → `{ answer: string }` (reads `projectId` from the review meta's… no — from the invoking context; store the review's `projectId` at creation? Phase 1: pass a configured project). Use `bb.sdk` current project: resolve via the review's stored project. **Add `projectId` to `ReviewMeta`** and persist it in Task 9 (`meta.projectId = ctx.projectId`). Update store schema with a new appended migration `ALTER TABLE reviews ADD COLUMN project_id TEXT`.

- [ ] **Step 1: Append the store migration + field**

In `src/store.ts` add to the `bb.storage.migrate` array (append-only, new last element):

```ts
    `ALTER TABLE reviews ADD COLUMN project_id TEXT`,
```

Add `projectId?: string` to `ReviewMeta`, include it in `saveReview` insert (`project_id=@projectId`, param `projectId: m.projectId ?? null`) and in `rowToMeta` (`projectId: r.project_id ?? undefined`). In Task 9's `meta`, set `meta.projectId = ctx.projectId`.

- [ ] **Step 2: Write the failing test (spawn stubbed, output stubbed)**

```ts
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./store";
import { runAssist } from "./assist";

test("assist returns the worker thread's output", async () => {
  const { bb } = createFakePluginHost({
    pluginId: "guided-review",
    sdk: {
      threads: {
        spawn: async () => ({ id: "th_a" }),
        wait: async () => {},
        output: async () => "Because it schedules a refresh before expiry.",
        archive: async () => {},
        stop: async () => {},
      },
    },
  });
  const store = createStore(bb);
  const res = await runAssist(bb, store, { targetKey: "pr-1", question: "why?", projectId: "p1" });
  expect(res.answer).toContain("refresh");
});
```

- [ ] **Step 3: Implement `src/assist.ts`**

```ts
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Store } from "./store";
import { splitPatchByFile } from "./patch";

interface AssistArgs {
  targetKey: string;
  chapterId?: string;
  file?: string;
  question: string;
  projectId: string;
}

export async function runAssist(bb: BbPluginApi, store: Store, args: AssistArgs): Promise<{ answer: string }> {
  const guide = store.getGuide(args.targetKey);
  const patch = store.readPatch(args.targetKey, 0, 5_000_000).text;
  const files = splitPatchByFile(patch);
  const scoped = args.file ? files.filter((f) => f.path === args.file) : files;
  const chapter = guide?.sections.find((s) => s.id === args.chapterId);

  const prompt = [
    "You are helping review a code change. Answer the reviewer's question concisely.",
    guide ? `Change intent: ${guide.intent}` : "",
    chapter ? `Chapter "${chapter.title}": ${chapter.overview}` : "",
    "Relevant diff:",
    "```diff",
    scoped.map((f) => f.text).join("\n").slice(0, 60_000),
    "```",
    `Question: ${args.question}`,
  ].filter(Boolean).join("\n");

  const worker = await bb.sdk.threads.spawn({
    projectId: args.projectId,
    environment: { type: "project-default" },
    prompt,
    title: `Assist: ${args.targetKey}`,
    visibility: "hidden",
  });
  try {
    await bb.sdk.threads.wait({ threadId: worker.id, status: "idle" });
    const answer = await bb.sdk.threads.output({ threadId: worker.id });
    return { answer: typeof answer === "string" ? answer : String(answer ?? "") };
  } finally {
    await bb.sdk.threads.archive({ threadId: worker.id }).catch(() => {});
    await bb.sdk.threads.stop({ threadId: worker.id }).catch(() => {});
  }
}
```

- [ ] **Step 4: Wire the rpc in contract + `server.ts`**

Contract:

```ts
  assist: {
    input: z.object({ targetKey: z.string(), chapterId: z.string().optional(), file: z.string().optional(), question: z.string().min(1) }).strict(),
    output: z.object({ answer: z.string() }),
  },
```

Handler:

```ts
import { runAssist } from "./src/assist";

  async assist({ targetKey, chapterId, file, question }) {
    const m = store.getReview(targetKey);
    if (!m?.projectId) return { answer: "This review has no associated project; re-run `bb review` inside a project." };
    return runAssist(bb, store, { targetKey, chapterId, file, question, projectId: m.projectId });
  },
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `npm test -- src/assist.test.ts src/store.test.ts`
Expected: PASS (store still green after the appended migration).

- [ ] **Step 6: Commit**

```bash
git add src/assist.ts src/assist.test.ts src/store.ts src/rpc-contract.ts server.ts && git commit -m "feat: inline agent-assist"
```

---

## Task 13: Frontend — nav panel + review list

**Files:**
- Modify: `app.tsx` (register `navPanel`)
- Create: `components/ReviewPanel.tsx`, `components/ReviewList.tsx`
- Test: `components/ReviewList.test.tsx`

**Interfaces:**
- Consumes: `rpcContract` type from `../src/rpc-contract`; `useRpc`, `useBbNavigate`.
- Produces: navPanel id `review`, path `review`; `ReviewPanel` routes by `subPath` (`""` → list; else → `ReviewWorkspace` (Task 14)).

- [ ] **Step 1: Register the panel in `app.tsx`**

```tsx
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ReviewPanel } from "./components/ReviewPanel";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "review",
    title: "Guided Review",
    icon: "GitPullRequest",
    path: "review",
    component: ReviewPanel,
  });
});
```

- [ ] **Step 2: Implement `components/ReviewPanel.tsx`**

```tsx
import { memo } from "react";
import { ReviewList } from "./ReviewList";
import { ReviewWorkspace } from "./ReviewWorkspace";

export const ReviewPanel = memo(function ReviewPanel({ subPath }: { subPath: string }) {
  const targetKey = subPath.split("/")[0] ?? "";
  return targetKey ? <ReviewWorkspace targetKey={targetKey} /> : <ReviewList />;
});
ReviewPanel.displayName = "ReviewPanel";
```

- [ ] **Step 3: Write the failing test for `ReviewList`**

```tsx
// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

test("review list renders rows from rpc", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
    rpc: {
      listReviews: () => ({ reviews: [{ targetKey: "pr-7", kind: "pr", number: 7, title: "Fix", status: "ready", createdAt: 1 }] }),
    },
  });
  await slot.findByText("Fix");
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npm test -- components/ReviewList.test.tsx`
Expected: FAIL.

- [ ] **Step 5: Implement `components/ReviewList.tsx`**

```tsx
import { memo, useEffect, useState } from "react";
import { useRpc, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";

export const ReviewList = memo(function ReviewList() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [reviews, setReviews] = useState<any[]>([]);

  useEffect(() => {
    void rpc.call("listReviews", null).then((r) => setReviews(r.reviews));
  }, [rpc]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-2 p-4">
      <h2 className="text-lg font-semibold text-foreground">Guided Reviews</h2>
      {reviews.length === 0 && (
        <p className="text-sm text-muted-foreground">Run <code>bb review &lt;pr&gt;</code> to start one.</p>
      )}
      {reviews.map((r) => (
        <button
          key={r.targetKey}
          onClick={() => navigate.toPluginPanel("review", { subPath: r.targetKey })}
          className="flex w-full items-center justify-between rounded-lg border border-border bg-card p-3 text-left hover:bg-muted"
        >
          <span className="text-sm text-foreground">{r.title ?? r.gitRef ?? r.targetKey}</span>
          <span className="text-xs text-muted-foreground">{r.status}</span>
        </button>
      ))}
    </div>
  );
});
ReviewList.displayName = "ReviewList";
```

- [ ] **Step 6: Run tests, expect PASS**

Run: `npm test -- components/ReviewList.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app.tsx components/ReviewPanel.tsx components/ReviewList.tsx components/ReviewList.test.tsx && git commit -m "feat: review nav panel + list"
```

---

## Task 14: Frontend — review workspace (header, chapters, diffs)

**Files:**
- Create: `components/ReviewWorkspace.tsx`, `components/ReviewHeader.tsx`, `components/ChapterNav.tsx`, `components/DiffViewer.tsx`
- Test: manual via `bb plugin dev` (host diff worker + layout are not reproduced by the harness)

**Interfaces:**
- Consumes: `getReview`, `getGuide`, `getPatch` rpc; `@pierre/diffs`.
- Produces: `ReviewWorkspace({ targetKey })` composing header + chapter nav + diff viewer; selecting a chapter filters diffs to its files.

- [ ] **Step 1: Implement `components/DiffViewer.tsx`**

```tsx
import { memo, useMemo } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { splitPatchByFile } from "../src/patch";

export const DiffViewer = memo(function DiffViewer({ patch, files }: { patch: string; files: string[] }) {
  const parsed = useMemo(() => {
    const scoped = splitPatchByFile(patch).filter((f) => files.includes(f.path)).map((f) => f.text).join("\n");
    return parsePatchFiles(scoped);
  }, [patch, files]);

  const theme = {
    dark: document.documentElement.dataset.bbCodeThemeDark,
    light: document.documentElement.dataset.bbCodeThemeLight,
  };

  return (
    <div className="space-y-4">
      {parsed.map((file, i) => (
        <FileDiff key={i} file={file} theme={theme} />
      ))}
    </div>
  );
});
DiffViewer.displayName = "DiffViewer";
```

> Note: `splitPatchByFile` is backend-shared pure code imported into the panel — verify at build that it has no Node-only imports (it doesn't). If the build complains, copy the pure function into `components/`.

- [ ] **Step 2: Implement `components/ChapterNav.tsx`**

```tsx
import { memo } from "react";
import { cn } from "./ui/lib/utils";

interface Section { id: string; title: string; overview: string; diffs: { file: string }[]; risk?: string }

export const ChapterNav = memo(function ChapterNav({
  sections, activeId, onSelect,
}: { sections: Section[]; activeId: string; onSelect: (id: string) => void }) {
  return (
    <nav className="space-y-1">
      {sections.map((s) => (
        <button
          key={s.id}
          onClick={() => onSelect(s.id)}
          className={cn(
            "w-full rounded-md border border-border p-2 text-left",
            s.id === activeId ? "bg-muted" : "bg-card hover:bg-muted",
          )}
        >
          <div className="text-sm font-medium text-foreground">{s.title}</div>
          <div className="line-clamp-2 text-xs text-muted-foreground">{s.overview}</div>
          <div className="mt-1 text-[10px] text-muted-foreground">{s.diffs.length} file(s)</div>
        </button>
      ))}
    </nav>
  );
});
ChapterNav.displayName = "ChapterNav";
```

- [ ] **Step 3: Implement `components/ReviewHeader.tsx`**

```tsx
import { memo } from "react";

export const ReviewHeader = memo(function ReviewHeader({ review }: { review: any }) {
  if (!review) return null;
  return (
    <header className="border-b border-border pb-2">
      <h2 className="text-base font-semibold text-foreground">{review.title ?? review.gitRef ?? review.targetKey}</h2>
      <p className="text-xs text-muted-foreground">
        {review.author ? `@${review.author} · ` : ""}
        {review.base && review.head ? `${review.base} ← ${review.head}` : review.gitRef}
        {" · "}{review.status}
      </p>
    </header>
  );
});
ReviewHeader.displayName = "ReviewHeader";
```

- [ ] **Step 4: Implement `components/ReviewWorkspace.tsx`**

```tsx
import { memo, useEffect, useMemo, useState } from "react";
import { useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import { ReviewHeader } from "./ReviewHeader";
import { ChapterNav } from "./ChapterNav";
import { DiffViewer } from "./DiffViewer";
import { DraftTray } from "./DraftTray";

export const ReviewWorkspace = memo(function ReviewWorkspace({ targetKey }: { targetKey: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [review, setReview] = useState<any>(null);
  const [guide, setGuide] = useState<any>(null);
  const [patch, setPatch] = useState("");
  const [activeId, setActiveId] = useState("");

  const load = useMemo(() => async () => {
    const [{ review }, { guide }, { patch }] = await Promise.all([
      rpc.call("getReview", { targetKey }),
      rpc.call("getGuide", { targetKey }),
      rpc.call("getPatch", { targetKey }),
    ]);
    setReview(review); setGuide(guide); setPatch(patch);
    if (guide?.sections?.[0]) setActiveId((prev) => prev || guide.sections[0].id);
  }, [rpc, targetKey]);

  useEffect(() => { void load(); }, [load]);
  useRealtime(`review:${targetKey}`, () => { void load(); });

  const activeFiles: string[] = useMemo(() => {
    const s = guide?.sections?.find((x: any) => x.id === activeId);
    return s ? s.diffs.map((d: any) => d.file) : [];
  }, [guide, activeId]);

  if (!guide) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {review?.status === "error" ? "Generation failed. Re-run `bb review`." : "Building the guide…"}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-3">
        <ReviewHeader review={review} />
        <p className="mt-1 text-sm text-foreground">{guide.intent}</p>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-border p-3">
          <ChapterNav sections={guide.sections} activeId={activeId} onSelect={setActiveId} />
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto p-4">
          <DiffViewer patch={patch} files={activeFiles} />
        </main>
      </div>
      <DraftTray targetKey={targetKey} activeChapterId={activeId} activeFiles={activeFiles} />
    </div>
  );
});
ReviewWorkspace.displayName = "ReviewWorkspace";
```

- [ ] **Step 5: Build and verify live**

```bash
bb plugin dev &        # rebuilds app on save
# In bb: open Guided Review panel; run `bb review <a small PR>` in a project thread;
# confirm chapters render on the left and diffs on the right.
```
Expected: panel shows the header/intent, chapter list, and syntax-highlighted diffs for the selected chapter.

- [ ] **Step 6: Commit**

```bash
git add components/ReviewWorkspace.tsx components/ReviewHeader.tsx components/ChapterNav.tsx components/DiffViewer.tsx && git commit -m "feat: review workspace"
```

---

## Task 15: Frontend — draft tray, submit, assist

**Files:**
- Create: `components/DraftTray.tsx`, `components/AssistPopover.tsx`
- Add: `npx shadcn add @bb/select @bb/textarea @bb/popover` (verdict select, comment box, assist popover)
- Test: manual via `bb plugin dev`

**Interfaces:**
- Consumes: `getDraft`, `saveDraftComment`, `removeDraftComment`, `setVerdict`, `submitReview`, `assist` rpc; `toast` from `sonner`.
- Produces: `DraftTray({ targetKey, activeChapterId, activeFiles })` with pending comments, a comment composer (file+line+body), verdict select, submit button, and an assist entry point.

- [ ] **Step 1: Add shadcn pieces**

```bash
npx shadcn add @bb/select @bb/textarea @bb/popover
npm install
```

- [ ] **Step 2: Implement `components/AssistPopover.tsx`**

```tsx
import { memo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export const AssistPopover = memo(function AssistPopover({
  targetKey, chapterId, file,
}: { targetKey: string; chapterId?: string; file?: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);

  async function ask() {
    setBusy(true);
    try {
      const { answer } = await rpc.call("assist", { targetKey, chapterId, file, question: q });
      setAnswer(answer);
    } finally { setBusy(false); }
  }

  return (
    <Popover>
      <PopoverTrigger asChild><Button variant="outline" size="sm">Ask the agent</Button></PopoverTrigger>
      <PopoverContent className="w-96 space-y-2">
        <Textarea value={q} onChange={(e) => setQ(e.target.value)} placeholder="Explain this chapter / is this safe?" />
        <Button size="sm" disabled={busy || !q} onClick={ask}>{busy ? "Thinking…" : "Ask"}</Button>
        {answer && <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm text-foreground">{answer}</p>}
      </PopoverContent>
    </Popover>
  );
});
AssistPopover.displayName = "AssistPopover";
```

- [ ] **Step 3: Implement `components/DraftTray.tsx`**

```tsx
import { memo, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { AssistPopover } from "./AssistPopover";

export const DraftTray = memo(function DraftTray({
  targetKey, activeChapterId, activeFiles,
}: { targetKey: string; activeChapterId: string; activeFiles: string[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState<any>({ verdict: "COMMENT", body: "", comments: [] });
  const [file, setFile] = useState(activeFiles[0] ?? "");
  const [line, setLine] = useState("1");
  const [body, setBody] = useState("");

  useEffect(() => { void rpc.call("getDraft", { targetKey }).then((r) => setDraft(r.draft)); }, [rpc, targetKey]);
  useEffect(() => { setFile(activeFiles[0] ?? ""); }, [activeFiles]);

  async function addComment() {
    const { draft } = await rpc.call("saveDraftComment", {
      targetKey,
      comment: { file, line: Number(line), side: "RIGHT", chapterId: activeChapterId, body },
    });
    setDraft(draft); setBody("");
  }
  async function removeComment(i: number) {
    const { draft } = await rpc.call("removeDraftComment", { targetKey, index: i });
    setDraft(draft);
  }
  async function submit() {
    await rpc.call("setVerdict", { targetKey, verdict: draft.verdict, body: draft.body });
    const res = await rpc.call("submitReview", { targetKey });
    if (res.ok) toast.success("Review submitted to GitHub");
    else toast.error(res.error ?? "Submit failed");
  }

  return (
    <div className="border-t border-border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{draft.comments.length} pending comment(s)</span>
        <div className="ml-auto flex items-center gap-2">
          <AssistPopover targetKey={targetKey} chapterId={activeChapterId} file={file} />
          <Select value={draft.verdict} onValueChange={(v) => setDraft({ ...draft, verdict: v })}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="COMMENT">Comment</SelectItem>
              <SelectItem value="APPROVE">Approve</SelectItem>
              <SelectItem value="REQUEST_CHANGES">Request changes</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" onClick={submit}>Submit review</Button>
        </div>
      </div>

      <ul className="max-h-24 overflow-y-auto text-xs">
        {draft.comments.map((c: any, i: number) => (
          <li key={i} className="flex items-center gap-2 text-foreground">
            <span className="text-muted-foreground">{c.file}:{c.line}</span>
            <span className="truncate">{c.body}</span>
            <button className="ml-auto text-destructive" onClick={() => removeComment(i)}>remove</button>
          </li>
        ))}
      </ul>

      <div className="flex items-end gap-2">
        <Input value={file} onChange={(e) => setFile(e.target.value)} placeholder="file" className="w-64" />
        <Input value={line} onChange={(e) => setLine(e.target.value)} placeholder="line" className="w-20" />
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="comment" className="flex-1" />
        <Button size="sm" disabled={!file || !body} onClick={addComment}>Add</Button>
      </div>

      <Textarea
        value={draft.body}
        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        placeholder="Review summary (posted as the review body)"
      />
    </div>
  );
});
DraftTray.displayName = "DraftTray";
```

- [ ] **Step 4: Build and verify live**

```bash
bb plugin dev
# In bb: open a generated review, add a comment, pick a verdict, submit.
# Verify the review appears on the real GitHub PR.
```
Expected: comment adds to the pending list; Submit posts one batched review to the PR; assist returns an answer.

- [ ] **Step 5: Commit**

```bash
git add components/DraftTray.tsx components/AssistPopover.tsx components/ui && git commit -m "feat: draft tray, submit, assist UI"
```

---

## Task 16: End-to-end dogfood + README

**Files:**
- Create: `README.md`
- Test: live end-to-end run

- [ ] **Step 1: Full build + install**

```bash
cd /Volumes/X9/Dev/bb-plugin-guided-review
npm test
bb plugin build
bb plugin reload guided-review
bb plugin list | grep guided-review     # running, no errors
```

- [ ] **Step 2: Live end-to-end against a throwaway PR**

In a scratch GitHub repo you control, open a small PR, then in a bb project thread on that repo:

```bash
bb review <that-pr-url>
```
Verify: CLI prints the "open the panel" message → panel shows chapters (heart → consequences → glue order) + diffs → add a comment → Ask the agent returns an answer → Submit with "Comment" → the batched review appears on the PR.

- [ ] **Step 3: Write `README.md`** (install, `bb review` usage, the Phase-1 feature list, `gh` auth prerequisite, and a Phase-2 roadmap pointer to the spec).

- [ ] **Step 4: Commit**

```bash
git add README.md && git commit -m "docs: readme + phase 1 complete"
```

---

## Self-Review (against the spec)

**Spec coverage:**
- §4 flow (resolve → patch → generate → panel → review → submit): Tasks 9, 8, 13–15, 11. ✓
- §5.1 CLI + tools + rpc: Tasks 9, 8, 10–12. ✓
- §5.2 panel (header, chapter nav, diff viewer, draft tray, assist): Tasks 13–15. ✓
- §5.3 generation (plannotator-exact skill): Task 8. ✓
- §6 data model (guide.json + review-draft): Tasks 4, 5, 7. ✓
- §7 GitHub batched post-back: Tasks 5, 6, 11. ✓
- §8 storage keyed by target: Task 7. ✓
- §9 errors (gh unauthed, generation failure, submit failure): Tasks 9 (`ghError`), 8 (coverage gate), 11 (submit error), 14 (error state). ✓
- §10 testing (unit validators/builders, component, e2e): Tasks 2–12 unit, 13 component, 16 e2e. ✓
- §11 Phase 1 incl. inline agent-assist: Task 12. ✓

**Placeholder scan:** Task 10 Step 1 contains an intentionally-labeled placeholder test that Step 1's follow-up code block replaces — ensure the real test (second block) is the one written. No other TBD/TODO.

**Type consistency:** `ReviewMeta` gains `projectId` in Task 12 (store migration appended, not edited). `targetKey`, `Guide`, `Draft`, `ReviewMeta`, and the rpc method names are used identically across tasks. `runGh`/`runGit` signature `{ cwd?, stdin? }` is consistent between Task 6 and its callers (Tasks 9, 11).

**Open execution notes:**
- Confirm exact `bb.sdk.threads.wait`/`output`/`archive`/`stop` signatures against `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts` when implementing Tasks 8/12 (run `bb plugin types` first). Shapes here follow the authoring skill; adjust field names if the pinned SDK differs.
- If `splitPatchByFile` import into the panel (Task 14) trips the frontend build (Node-free but shared), copy the pure function into `components/`.
