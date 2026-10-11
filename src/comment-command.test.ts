import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { targetKey } from "./targets";
import { runGh } from "./gh";

vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn() }));

const key = targetKey({ kind: "pr", number: 7, repo: "acme/web" });
const url = "https://github.com/acme/web/pull/7";
const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n keep();\n-old();\n+next();\n";

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: key, kind: "pr", number: 7, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  store.savePatch(key, patch);
  const cli = (...argv: string[]) => harness.behavior.runCli(["comment", ...argv]);
  return { harness, store, cli };
}

test("bb review comment adds, lists, edits, and deletes local draft comments, and never calls GitHub", async () => {
  const { harness, store, cli } = await host();
  expect(await cli("add", url, "a.ts:2", "--code", "next();", "--body", "Why rename?\nIt breaks callers.")).toMatchObject({ exitCode: 0, stdout: "Added a draft comment on a.ts:2. It stays in bb until the reviewer submits the review." });
  expect(await cli("add", key, "a.ts:2", "--side", "left", "--code", "old();", "--body", "Was this used?")).toMatchObject({ exitCode: 0 });
  store.upsertDraftComment(key, { file: "a.ts", line: 1, side: "RIGHT", body: "Reviewer's own" });

  expect((await cli("list", url)).stdout).toBe([
    "3 draft comments:",
    "a.ts:2 RIGHT · added by an agent\n  Why rename?\n  It breaks callers.",
    "a.ts:2 LEFT · added by an agent\n  Was this used?",
    "a.ts:1 RIGHT · added by the reviewer\n  Reviewer's own",
  ].join("\n"));
  expect(JSON.parse((await cli("list", url, "--json")).stdout).comments[2]).toEqual({ file: "a.ts", line: 1, side: "RIGHT", author: "reviewer", severity: "none", body: "Reviewer's own", stale: false });

  expect(await cli("edit", url, "a.ts:2", "--body", "Reworded")).toMatchObject({ exitCode: 0, stdout: "Updated the draft comment on a.ts:2." });
  expect(await cli("delete", url, "a.ts:2", "--side", "LEFT")).toMatchObject({ exitCode: 0, stdout: "Deleted the draft comment on a.ts:2 (LEFT side)." });
  expect(store.getDraft(key).comments.map((c) => [c.line, c.side, c.author ?? "reviewer", c.body])).toEqual([
    [2, "RIGHT", "agent", "Reworded"], [1, "RIGHT", "reviewer", "Reviewer's own"],
  ]);
  // An open panel refreshes after each change.
  expect(harness.inspection.realtimeSignals.filter((signal) => signal.channel === `draft:${key}`)).toHaveLength(4);
  expect(runGh).not.toHaveBeenCalled();
});

test("bb review comment changes an agent's comments but not the reviewer's", async () => {
  const { store, cli } = await host();
  store.upsertDraftComment(key, { file: "a.ts", line: 1, side: "RIGHT", body: "Reviewer's own" });
  const refused = { exitCode: 1, stderr: "The reviewer wrote this comment. Suggest the change in chat; they can ask on the comment to have you apply it. Nothing was changed." };
  expect(await cli("edit", url, "a.ts:1", "--body", "Reworded")).toMatchObject(refused);
  expect(await cli("delete", url, "a.ts:1")).toMatchObject(refused);
  expect(store.getDraft(key).comments).toEqual([{ file: "a.ts", line: 1, side: "RIGHT", body: "Reviewer's own" }]);
});

test("bb review comment explains refusals and usage mistakes", async () => {
  const { store, cli } = await host();
  expect(await cli("add", url, "a.ts:1", "--code", "next();", "--body", "x")).toMatchObject({ exitCode: 1, stderr: "Line 1 on the RIGHT side of a.ts is `keep();`. The code you sent is on line 2. Nothing was added." });
  expect(await cli("edit", url, "a.ts:9", "--body", "x")).toMatchObject({ exitCode: 1, stderr: "There's no draft comment on a.ts:9." });
  expect(await cli("list", "https://github.com/acme/web/pull/8")).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("No saved review for") });
  for (const argv of [[], ["move", url], ["add", url, "a.ts:2", "--body", "x"], ["edit", url, "a.ts:2"], ["edit", url, "a.ts:2", "--body", "  "],
    ["delete", url, "a.ts"], ["delete", url, "a.ts:2", "--side", "UP"], ["delete", url, "a.ts:2", "--body", "x"], ["list", url, "--json", "--json"], ["add", url, "a.ts:2", "--code"]]) {
    expect({ argv, ...(await cli(...argv)) }).toMatchObject({ argv, exitCode: 2, stderr: expect.stringContaining("usage: bb review comment") });
  }
  expect(store.getDraft(key).comments).toEqual([]);
  expect(await cli("--help")).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("Nothing is posted to GitHub") });
  expect(await cli("add", "--help")).toMatchObject({ exitCode: 0 });
});

test("bb review comment sets a comment's severity with --severity or a label, and lists it", async () => {
  const { store, cli } = await host();
  expect(await cli("add", url, "a.ts:2", "--code", "next();", "--severity", "Should-fix", "--body", "Rename it back.")).toMatchObject({ exitCode: 0 });
  expect(await cli("add", url, "a.ts:2", "--side", "LEFT", "--code", "old();", "--body", "**Question:** Was this used?")).toMatchObject({ exitCode: 0 });
  expect(store.getDraft(key).comments.map((c) => [c.severity, c.body])).toEqual([["should-fix", "Rename it back."], ["question", "Was this used?"]]);
  expect((await cli("list", url)).stdout).toContain("a.ts:2 RIGHT · added by an agent · should-fix\n  Rename it back.");
  expect(JSON.parse((await cli("list", url, "--json")).stdout).comments[1].severity).toBe("question");
  expect(await cli("edit", url, "a.ts:2", "--body", "Rename it back, please.")).toMatchObject({ exitCode: 0 });
  expect(store.getDraft(key).comments[0]).toMatchObject({ severity: "should-fix", body: "Rename it back, please." });
  expect(await cli("edit", url, "a.ts:2", "--severity", "none", "--body", "Rename it back, please.")).toMatchObject({ exitCode: 0 });
  expect(store.getDraft(key).comments[0]).not.toHaveProperty("severity");
  expect(await cli("add", url, "a.ts:1", "--code", "keep();", "--severity", "major", "--body", "x")).toMatchObject({ exitCode: 2, stderr: expect.stringMatching(/^--severity is blocking, should-fix, question, nit, or none\./) });
  expect(await cli("delete", url, "a.ts:2", "--severity", "nit")).toMatchObject({ exitCode: 2, stderr: expect.stringMatching(/^delete doesn't take --severity/) });
});
