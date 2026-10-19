import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createStore } from "./store";
import { targetKey } from "./targets";
import { runGh } from "./gh";

vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh: vi.fn() }));

const key = targetKey({ kind: "pr", number: 7, repo: "acme/web" });
const url = "https://github.com/acme/web/pull/7";

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview({ targetKey: key, kind: "pr", number: 7, repo: "acme/web", status: "ready", createdAt: 1, headSha: "sha1" });
  const cli = (...argv: string[]) => harness.behavior.runCli(["summary", ...argv]);
  return { harness, store, cli };
}

test("bb review summary shows and writes the local review summary as an agent, and never calls GitHub", async () => {
  const { harness, store, cli } = await host();
  expect(await cli(url)).toMatchObject({ exitCode: 0, stdout: "The draft has no review summary yet.\nVerdict: the reviewer hasn't picked one, so it's Comment by default." });
  expect(await cli(key, "--body", "Looks right.\nOne risk at a.ts:2.", "--suggest", "approve")).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("Wrote the review summary. Your suggested verdict, Approve") });
  expect(store.getDraft(key)).toMatchObject({ body: "Looks right.\nOne risk at a.ts:2.", bodyAuthor: "agent", suggestedVerdict: "APPROVE" });
  expect((await cli(url)).stdout).toBe("Review summary · written by an agent\n  Looks right.\n  One risk at a.ts:2.\nVerdict: the reviewer hasn't picked one, so it's Comment by default.\nAn agent's suggested verdict: Approve.");
  store.setVerdict(key, "REQUEST_CHANGES");
  expect(JSON.parse((await cli(url, "--json")).stdout)).toEqual({ review: key, body: "Looks right.\nOne risk at a.ts:2.", author: "agent", verdict: "REQUEST_CHANGES", verdictChosen: true, suggestedVerdict: "APPROVE" });
  // An open panel refreshes after the change.
  expect(harness.inspection.realtimeSignals.filter((signal) => signal.channel === `draft:${key}`)).toHaveLength(1);
  expect(runGh).not.toHaveBeenCalled();
});

test("bb review summary leaves the reviewer's summary alone and explains usage mistakes", async () => {
  const { store, cli } = await host();
  store.updateSummary(key, { body: "Mine." });
  expect(await cli(url, "--body", "Better.")).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("The reviewer wrote the review summary") });
  expect(JSON.parse((await cli(url, "--json")).stdout)).toMatchObject({ body: "Mine.", author: "reviewer", verdictChosen: false, suggestedVerdict: null });
  expect(await cli("https://github.com/acme/web/pull/8")).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("No saved review for") });
  for (const argv of [[], [url, key], [url, "--body"], [url, "--body", "  "], [url, "--suggest", "APPROVE"], [url, "--body", "x", "--suggest", "LGTM"],
    [url, "--body", "x", "--json"], [url, "--json", "--json"], [url, "--side", "LEFT"]]) {
    expect({ argv, ...(await cli(...argv)) }).toMatchObject({ argv, exitCode: 2, stderr: expect.stringContaining("usage: bb review summary") });
  }
  expect(store.getDraft(key).body).toBe("Mine.");
  expect(await cli("--help")).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("Nothing is posted to GitHub") });
});
