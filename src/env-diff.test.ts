import { expect, test } from "vitest";
import { changedFiles } from "./patch";
import { hiddenFileNotice, isSecretPath, readFeatureDiff, type FeatureDiff } from "./env-diff";
import { BASE_SHA, folderHost, type Folder } from "./env-diff.test-support";

const feature = { environmentId: "env1", machine: "MaxBook", repo: "acme/api" };
const read = (folder: Folder, include?: string[]) => readFeatureDiff(folderHost(folder).bb, feature, include);
const available = (diff: FeatureDiff) => {
  if (diff.outcome !== "available") throw new Error(`${diff.outcome}: ${diff.message}`);
  return diff;
};

test("an untracked .env stays out of the patch with its reason, and Include brings it in", async () => {
  const folder: Folder = { files: [{ path: "src/a.ts" }, { path: ".env", origin: "untracked", body: "@@ -0,0 +1 @@\n+TOKEN=hunter2\n" }] };
  const diff = available(await read(folder));
  expect(changedFiles(diff.patch)).toEqual(["src/a.ts"]);
  expect(diff.patch).not.toContain("hunter2");
  expect(diff.hidden).toEqual([{ path: ".env", reason: "secret" }]);
  // Its revision is kept, so a later edit to it still shows as a change.
  expect(Object.keys(diff.revisions)).toEqual(["src/a.ts", ".env"]);
  expect(hiddenFileNotice(diff.hidden[0]!)).toBe(".env looks like a secret, so it isn’t shown or sent to agents. Include it to review it.");

  const included = available(await read(folder, [".env"]));
  expect(changedFiles(included.patch)).toEqual(["src/a.ts", ".env"]);
  expect(included.hidden).toEqual([]);
});

test("a committed .env shows, flagged", async () => {
  const diff = available(await read({ files: [{ path: "config/.env.production", origin: "tracked" }, { path: "certs/server.pem", origin: "untracked" }] }));
  expect(changedFiles(diff.patch)).toEqual(["config/.env.production"]);
  expect(diff.flagged).toEqual(["config/.env.production"]);
  expect(diff.hidden).toEqual([{ path: "certs/server.pem", reason: "secret" }]);
});

test("secret-looking names", () => {
  for (const path of [".env", "app/.env.local", ".envrc", "server.pem", "id.KEY", "credentials.json", "aws/Credentials"]) expect(isSecretPath(path)).toBe(true);
  for (const path of ["env.ts", "src/environment.ts", "keys.ts", "docs/credential-rotation.md", "pem/readme.md"]) expect(isSecretPath(path)).toBe(false);
});

test("a binary stays out, and included, shows as GitHub shows one: no encoded contents", async () => {
  const folder: Folder = { files: [{ path: "logo.png", binary: true, origin: "untracked" }] };
  const diff = available(await read(folder));
  expect(diff.patch).toBe("");
  expect(diff.hidden).toEqual([{ path: "logo.png", reason: "binary" }]);
  const included = available(await read(folder, ["logo.png"]));
  expect(included.patch).toContain("Binary files /dev/null and b/logo.png differ");
  expect(included.patch).not.toContain("GIT binary patch");
});

test("a diff bb won't load whole, or cuts, stays out as too large; one it loads on demand is read", async () => {
  const folder: Folder = { files: [
    { path: "huge.sql", lines: 30_000, truncated: true },
    { path: "cut.json", lines: 900, truncated: true },
    { path: "big.ts", lines: 900 },
  ] };
  const diff = available(await read(folder));
  expect(changedFiles(diff.patch)).toEqual(["big.ts"]);
  expect(diff.hidden).toEqual([{ path: "huge.sql", reason: "large" }, { path: "cut.json", reason: "large" }]);
  expect(hiddenFileNotice(diff.hidden[0]!)).toBe("huge.sql’s diff is too large to show. Review it in the folder.");
  // Included, a cut diff still stays out: it would end mid-hunk.
  expect(available(await read(folder, ["huge.sql"])).hidden).toEqual([{ path: "huge.sql", reason: "large" }, { path: "cut.json", reason: "large" }]);
});

test("patches are read 50 at a time at the merge base's commit, and a cut file list says so", async () => {
  const files = Array.from({ length: 130 }, (_, i) => ({ path: `src/f${String(i).padStart(3, "0")}.ts` }));
  const { bb, calls } = folderHost({ files, listLimit: 120 });
  const diff = available(await readFeatureDiff(bb, feature));
  expect(changedFiles(diff.patch)).toEqual(files.slice(0, 120).map((f) => f.path));
  const batches = calls.filter((c) => c.method === "patches").map((c) => c.input.keys.length);
  expect(batches).toEqual([50, 50, 20]);
  for (const { input } of calls.filter((c) => c.method === "patches")) {
    for (const key of input.keys) expect(JSON.parse(key).slice(0, 3)).toEqual(["env1", { type: "all", mergeBaseBranch: BASE_SHA }, false]);
  }
  expect(diff.notice).toBe("This folder has more changed files than BB lists at once, so the review has the first 120.");
  expect(diff.mergeBaseRef).toBe(BASE_SHA);
});

test("the base: the PR's, else bb's merge base for the folder, else what it was made from, else its default branch", async () => {
  const base = async (folder: Folder, known: { repo?: string | null } = {}) => {
    const { bb, calls } = folderHost(folder);
    const diff = available(await readFeatureDiff(bb, { ...feature, ...known }));
    return [diff.base, calls.find((c) => c.method === "files")!.input.target.mergeBaseBranch];
  };
  const files = [{ path: "a.ts" }];
  // A bb worktree's merge base is where it was spawned; once the branch has a PR, GitHub's base is the one that counts.
  expect(await base({ files, env: { mergeBaseBranch: "d49cbbcf833078585cd0e4634414e52abc123aff", baseBranch: "dev" }, prBase: "staging" })).toEqual(["staging", "staging"]);
  expect(await base({ files, env: { mergeBaseBranch: "release/2", baseBranch: "dev" } })).toEqual(["release/2", "release/2"]);
  expect(await base({ files, env: { baseBranch: "dev" } })).toEqual(["dev", "dev"]);
  expect(await base({ files })).toEqual(["main", "main"]);
  // A folder with no GitHub repo has no PR to ask about.
  expect(await base({ files, env: { mergeBaseBranch: "release/2" }, prLookup: "throws" }, { repo: null })).toEqual(["release/2", "release/2"]);
  expect(await read({ files, env: { defaultBranch: null } })).toEqual({ outcome: "unavailable", message: "Couldn’t find a base branch to compare this folder with. Choose one in its Diff tab, then try again." });
});

test("when bb can't say whether the branch has a PR, the last read's base stays, and with none the read waits", async () => {
  const files = [{ path: "a.ts" }];
  for (const prLookup of ["unavailable", "throws"] as const) {
    const { bb } = folderHost({ files, env: { mergeBaseBranch: "main" }, prLookup });
    expect(available(await readFeatureDiff(bb, { ...feature, baseRef: "staging" })).base).toBe("staging");
    expect(await readFeatureDiff(bb, feature)).toEqual({ outcome: "unavailable", message: "Couldn’t check whether this branch has a PR, so its base isn’t known yet. Try again in a moment." });
  }
});

test("a Git plugin that answers in another shape fails the read instead of guessing", async () => {
  const files = [{ path: "a.ts" }, { path: "b.ts", lines: 900 }];
  const { bb: unrevised } = folderHost({ files, answers: { files: () => ({ outcome: "available", files: [{ path: "a.ts", previousPath: null, changeKind: "modified", binary: false, origin: "tracked", loadMode: "auto" }], truncated: false, mergeBaseRef: BASE_SHA, initialPatches: [] }) } });
  expect((await readFeatureDiff(unrevised, feature)).outcome).toBe("unavailable");
  const { bb: keyless } = folderHost({ files, answers: { patches: () => ({}) } });
  expect(await readFeatureDiff(keyless, feature)).toEqual({ outcome: "unavailable", message: "Couldn’t read the folder’s changes: BB sent no diff for b.ts." });
  for (const mergeBaseRef of ["main", "abc123", null]) {
    const { bb } = folderHost({ files, answers: { files: () => ({ outcome: "available", files: [], truncated: false, shortstat: "", mergeBaseRef, initialPatches: [] }) } });
    expect(await readFeatureDiff(bb, feature)).toEqual({ outcome: "unavailable", message: "Couldn’t find where this folder’s branch left main." });
  }
});

test("a file whose diff comes back empty was reverted since the list, so it's left out of the review whole", async () => {
  const diff = available(await read({ files: [{ path: "a.ts" }, { path: "b.ts", lines: 900, reverted: true }] }));
  expect(changedFiles(diff.patch)).toEqual(["a.ts"]);
  expect(diff.hidden).toEqual([]);
  expect(Object.keys(diff.revisions)).toEqual(["a.ts"]);
});

test("an offline machine, a removed folder, and a failed read each say what happened", async () => {
  const files = [{ path: "a.ts" }];
  const asleep = folderHost({ files, connected: false });
  expect(await readFeatureDiff(asleep.bb, feature)).toEqual({ outcome: "offline", message: "MaxBook is offline. Wake it to see the folder’s latest changes." });
  expect(asleep.calls).toEqual([]);
  // It went to sleep mid-read.
  const host = folderHost({ files, throws: "Host request timed out" });
  let connected = true;
  host.harness.inspection.sdk.stub("hosts.get", async () => ({ id: "host_max", name: "MaxBook", status: (connected = !connected) ? "disconnected" : "connected", lifecycle: { phase: "active" } }));
  expect((await readFeatureDiff(host.bb, feature)).outcome).toBe("offline");
  expect(await read({ files, throws: "boom" })).toEqual({ outcome: "unavailable", message: "Couldn’t read the folder’s changes: boom" });

  expect(await read({ files, missing: true })).toEqual({ outcome: "gone", message: "BB removed this folder, so its changes can’t be read." });
  expect((await read({ files, env: { status: "destroyed" } })).outcome).toBe("gone");
  expect(await read({ files, filesFailure: { outcome: "unavailable", failure: { code: "path_not_found", workspacePath: "/Users/me/src/api", message: "Path does not exist" } } }))
    .toEqual({ outcome: "gone", message: "The folder is no longer on its machine, so its changes can’t be read." });
  expect(await read({ files, filesFailure: { outcome: "unavailable", failure: { code: "permission_denied", workspacePath: "/Users/me/src/api", message: "Permission denied" } } }))
    .toEqual({ outcome: "unavailable", message: "Couldn’t read the folder’s changes: Permission denied" });
  expect(await read({ files, filesFailure: { outcome: "not_applicable", reason: "non_git_environment", message: "Workspace diff is not available for non-git environments" } }))
    .toEqual({ outcome: "unavailable", message: "This folder isn’t a git repository, so it has no changes to review." });
  expect(await read({ files, env: { status: "provisioning" } })).toEqual({ outcome: "unavailable", message: "The folder is still being set up. Try again in a moment." });
});
