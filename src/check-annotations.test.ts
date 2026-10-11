import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, type ReviewMeta } from "./store";
import { readCheckFailures } from "./check-annotations";

const runGh = vi.hoisted(() => vi.fn());
vi.mock("./gh", async (original) => ({ ...await original<typeof import("./gh")>(), runGh }));
import plugin from "../server";

const ok = (stdout: string) => ({ stdout, stderr: "", code: 0 });
const pr: ReviewMeta = { targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, headSha: "head1", status: "ready", createdAt: 1 };
const runs = { check_runs: [
  { id: 1, name: "lint", conclusion: "failure", html_url: "https://github.com/acme/web/runs/1", output: { annotations_count: 2 } },
  { id: 2, name: "test", conclusion: "success", html_url: "https://github.com/acme/web/runs/2", output: { annotations_count: 1 } },
  { id: 3, name: "build", conclusion: "failure", html_url: "https://github.com/acme/web/runs/3", output: { annotations_count: 0 } },
] };
const annotations = [
  { path: "src/a.ts", start_line: 3, end_line: 3, annotation_level: "failure", title: "no-unused-vars", message: "'x' is unused." },
  { path: "src/a.ts", start_line: 5, end_line: 5, annotation_level: "warning", title: null, message: "Prefer const." },
];

function github() {
  return vi.fn(async (args: string[]) => {
    const url = args.find((arg) => arg.startsWith("repos/"))!;
    if (url.startsWith("repos/acme/web/commits/head1/check-runs")) return ok(JSON.stringify(runs));
    if (url.startsWith("repos/acme/web/check-runs/1/annotations")) return ok(JSON.stringify(annotations));
    return { stdout: "", stderr: "HTTP 404", code: 1 };
  });
}

test("CI failures come from the reviewed head's failed check runs, failure annotations only", async () => {
  const gh = github();
  expect(await readCheckFailures(gh, pr)).toEqual([
    { file: "src/a.ts", line: 3, check: "lint", title: "no-unused-vars", message: "'x' is unused.", url: "https://github.com/acme/web/runs/1" },
  ]);
  // Only the failed run with annotations is asked for them.
  expect(gh).toHaveBeenCalledTimes(2);
  expect(await readCheckFailures(gh, { ...pr, kind: "ref" })).toEqual([]);
});

test("getCheckFailures says nothing when GitHub can't be read", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  createStore(bb).saveReview(pr);
  runGh.mockResolvedValue({ stdout: "", stderr: "HTTP 502", code: 1 });
  expect(await harness.behavior.callRpc("getCheckFailures", { targetKey: "pr-1" })).toEqual({ failures: [] });
  runGh.mockImplementation(github());
  expect((await harness.behavior.callRpc("getCheckFailures", { targetKey: "pr-1" }) as any).failures).toHaveLength(1);
});
