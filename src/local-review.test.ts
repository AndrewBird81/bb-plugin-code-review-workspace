import { afterEach, expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store";
import { runReviewCommand } from "./review-command";
import { gitDiffArgs, runGit } from "./gh";
import { ensureGitHeaders } from "./patch";
import { defaultPreferences } from "./preferences";
import plugin from "../server";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
function setup() {
  const { bb } = createFakePluginHost({ pluginId: "guided-review", sdk: { threads: { spawn: async () => { throw new Error("fixture worker"); } } } });
  return { bb, store: createStore(bb), gh: { runGit, runGh: vi.fn() } };
}
async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), "guided-review-"));
  dirs.push(cwd);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Review Fixture"], ["config", "user.email", "fixture@example.invalid"]]) {
    expect((await runGit(args, { cwd })).code).toBe(0);
  }
  await writeFile(join(cwd, "code.txt"), "before\n");
  await runGit(["add", "code.txt"], { cwd });
  expect((await runGit(["commit", "-m", "fixture"], { cwd })).code).toBe(0);
  await writeFile(join(cwd, "code.txt"), "after\n");
  return cwd;
}

test("two repositories reviewed at HEAD retain separate local patches and drafts", async () => {
  const deps = setup();
  const first = await repository();
  const second = await repository();
  await writeFile(join(second, "code.txt"), "other repository\n");
  expect((await runReviewCommand(deps, ["HEAD"], { projectId: "p1", cwd: first })).exitCode).toBe(0);
  expect((await runReviewCommand(deps, ["HEAD"], { projectId: "p1", cwd: second })).exitCode).toBe(0);
  const reviews = deps.store.listReviews();
  expect(reviews).toHaveLength(2);
  expect(deps.store.patch(reviews.find((r) => r.cwd === first)!.targetKey)).toContain("+after");
  expect(deps.store.patch(reviews.find((r) => r.cwd === second)!.targetKey)).toContain("+other repository");
  expect(deps.gh.runGh).not.toHaveBeenCalled();
});

test("--base before the target parses correctly and option errors never invoke git", async () => {
  const deps = setup();
  const cwd = await repository();
  await runGit(["checkout", "-b", "feature"], { cwd });
  await runGit(["commit", "-am", "change"], { cwd });
  expect((await runReviewCommand(deps, ["--base", "main", "feature"], { projectId: "p1", cwd })).exitCode).toBe(0);
  expect(deps.store.listReviews()[0].gitRef).toBe("main...feature");
  const git = vi.fn();
  for (const argv of [["HEAD", "--base"], ["--output=/tmp/overwrite", "HEAD"], ["HEAD", "extra"]]) {
    expect((await runReviewCommand({ ...deps, gh: { ...deps.gh, runGit: git } }, argv, { projectId: "p1", cwd })).exitCode).toBe(2);
  }
  expect(git).not.toHaveBeenCalled();
});

test("missing cwd cannot accidentally review the BB server working directory", async () => {
  const deps = setup();
  const git = vi.fn();
  expect((await runReviewCommand({ ...deps, gh: { ...deps.gh, runGit: git } }, ["HEAD"], { projectId: "p1" })).exitCode).toBe(2);
  expect(git).not.toHaveBeenCalled();
});

test("checkForUpdates says when a local review's code changed since its guide, unless its switch is off or its checkout is gone", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  const cwd = await repository();
  store.saveReview({ targetKey: "local", kind: "ref", gitRef: "HEAD", cwd, status: "ready", createdAt: 1, projectId: "p1" });
  store.savePatch("local", ensureGitHeaders((await runGit(gitDiffArgs("HEAD"), { cwd })).stdout));
  const check = () => harness.behavior.callRpc("checkForUpdates", { targetKey: "local" });
  expect(await check()).toEqual({ hasNewCommits: false });
  await writeFile(join(cwd, "code.txt"), "after, edited\n");
  expect(await check()).toEqual({ hasNewCommits: false, localChanged: true });
  const { revision } = store.getPreferences();
  store.savePreferences({ ...defaultPreferences, knobs: { ...defaultPreferences.knobs, localDiffChanges: false } }, revision);
  expect(await check()).toEqual({ hasNewCommits: false });
  store.savePreferences({ ...defaultPreferences }, revision + 1);
  await rm(cwd, { recursive: true, force: true });
  expect(await check()).toEqual({ hasNewCommits: false });
});
