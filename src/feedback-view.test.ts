import { expect, test, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, type ReviewMeta } from "./store";
import { diffAt } from "./feedback-view";
import { changedFiles } from "./patch";

const tooLarge = { code: 1, stdout: '{"message":"Sorry, the diff exceeded the maximum number of files (300). Consider using \'List pull requests files\' API or locally cloning the repository instead.","errors":[{"resource":"PullRequest","field":"diff","code":"too_large"}]}', stderr: "gh: HTTP 406" };
const file = (filename: string) => JSON.stringify({ filename, status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" });

function setup() {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  const store = createStore(bb);
  const review: ReviewMeta = { targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, base: "main", headSha: "sha1", latestHeadSha: "sha2", status: "ready", createdAt: 1 };
  store.saveReview(review);
  return { store, review };
}

test("the PR's head diff, too big for GitHub's diff, is rebuilt from the PR's files", async () => {
  const { store, review } = setup();
  const run = vi.fn(async (args: string[]) => (args[1] === "diff" ? tooLarge : { code: 0, stdout: file("now.ts") + "\n", stderr: "" }));
  expect(changedFiles(await diffAt(store, run, review, "sha2"))).toEqual(["now.ts"]);
  expect(run.mock.calls[1][0]).toEqual(["api", "--paginate", "repos/acme/web/pulls/1/files?per_page=100", "--jq", ".[] | @json"]);
});

test("an earlier commit's diff, too big for GitHub's diff, is rebuilt from the comparison's files", async () => {
  const { store, review } = setup();
  const run = vi.fn(async (args: string[]) => (args.includes("Accept: application/vnd.github.diff") ? tooLarge : { code: 0, stdout: file("then.ts") + "\n", stderr: "" }));
  expect(changedFiles(await diffAt(store, run, review, "sha0"))).toEqual(["then.ts"]);
  expect(run.mock.calls[1][0]).toEqual(["api", "repos/acme/web/compare/main...sha0", "--jq", ".files[] | @json"]);
});
