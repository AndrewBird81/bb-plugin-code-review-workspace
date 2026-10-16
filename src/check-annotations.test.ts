import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, type ReviewMeta } from "./store";
import { readCheckFailures, readCheckLog } from "./check-annotations";

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

test("a failed run's log is read with gh run view --log-failed, and its last 200 lines kept, 20,000 characters at most", async () => {
  const gh = vi.fn(async (_args: string[]) => ok(Array.from({ length: 500 }, (_, i) => `test\tstep\tline ${i + 1}`).join("\n") + "\n"));
  const read = await readCheckLog(gh, pr, 123);
  expect(gh).toHaveBeenCalledWith(["run", "view", "123", "--log-failed", "--repo", "acme/web"]);
  expect(read.ok && read.log.split("\n")).toEqual(Array.from({ length: 200 }, (_, i) => `test\tstep\tline ${i + 301}`));
  // Long lines: the end is kept, from a line's start.
  gh.mockResolvedValueOnce(ok(Array.from({ length: 50 }, (_, i) => `${i}:${"x".repeat(999)}`).join("\n")));
  const long = await readCheckLog(gh, pr, 123);
  expect(long.ok && long.log.length).toBeLessThanOrEqual(20_000);
  expect(long.ok && long.log.split("\n").map((line) => line.split(":")[0])).toEqual(Array.from({ length: 19 }, (_, i) => String(i + 31)));
});

test("a log gh can't read says why, an empty one says so, and a local review has none", async () => {
  const gh = vi.fn(async (_args: string[]) => ({ stdout: "", stderr: "HTTP 404: Not Found\nmore", code: 1 }));
  expect(await readCheckLog(gh, pr, 9)).toEqual({ ok: false, error: "Couldn’t read the check’s log: HTTP 404: Not Found" });
  gh.mockResolvedValueOnce(ok("\n"));
  expect(await readCheckLog(gh, pr, 9)).toEqual({ ok: false, error: "The check’s log has no failed steps to show." });
  gh.mockClear();
  expect(await readCheckLog(gh, { ...pr, kind: "ref", repo: undefined }, 9)).toMatchObject({ ok: false });
  expect(gh).not.toHaveBeenCalled();
});

test("getCheckLog reads a PR's run, and refuses a local review", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "guided-review" });
  await plugin(bb);
  const store = createStore(bb);
  store.saveReview(pr);
  store.saveReview({ targetKey: "local", kind: "ref", gitRef: "main", status: "ready", createdAt: 1 });
  runGh.mockReset();
  runGh.mockResolvedValue(ok("build\tnpm test\tFAIL src/a.test.ts\n"));
  expect(await harness.behavior.callRpc("getCheckLog", { targetKey: "pr-1", runId: 77 })).toEqual({ ok: true, log: "build\tnpm test\tFAIL src/a.test.ts" });
  expect(runGh).toHaveBeenCalledWith(["run", "view", "77", "--log-failed", "--repo", "acme/web"]);
  runGh.mockClear();
  expect(await harness.behavior.callRpc("getCheckLog", { targetKey: "local", runId: 77 })).toMatchObject({ ok: false, error: "Only a PR’s checks have logs to read." });
  expect(runGh).not.toHaveBeenCalled();
});
