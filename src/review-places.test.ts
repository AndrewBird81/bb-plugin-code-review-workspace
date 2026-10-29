import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { reviewIdentity } from "../lib/review-identity";
import { remoteRepo } from "./review-places";
import { testStore } from "./test-store.test-support";

const bbSdk = {
  projects: { list: async () => [{ id: "p1", kind: "standard", name: "api", gitRemoteUrl: "git@github.com:flosports/api.git" }, { id: "p2", kind: "personal", name: "Personal", gitRemoteUrl: null }] },
  system: { config: async () => ({ primaryHostId: "host_server" }) },
  hosts: { get: async () => ({ id: "host_server", name: "MaxBook", status: "connected", lifecycle: { phase: "ready" } }) },
};

test("a remote's URL gives its owner and repository, in each form git takes", () => {
  for (const url of ["https://github.com/flosports/api.git", "https://github.com/flosports/api", "git@github.com:flosports/api.git", "ssh://git@github.com/flosports/api/", " https://gitlab.example/flosports/api.git\n"]) {
    expect(remoteRepo(url), url).toBe("flosports/api");
  }
  expect(remoteRepo(null)).toBeNull();
  expect(remoteRepo("not a url")).toBeNull();
});

test("the list and an open review carry where a local review's code is, and what tells apart ids that would match", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: bbSdk as any });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "ref-1", kind: "ref", gitRef: "HEAD", cwd: "/Users/ana/src/api", status: "ready", createdAt: 1, projectId: "p1" });
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "flosports/api", number: 4512, title: "Fix login race", status: "ready", createdAt: 2, projectId: "p1" });
  await store.saveReview({ targetKey: "pr-2", kind: "pr", repo: "acme/api", number: 7, title: "Other", status: "ready", createdAt: 3, projectId: "p1" });
  await store.saveReview({ targetKey: "pr-3", kind: "pr", repo: "flosports/web", number: 9, title: "Web", status: "ready", createdAt: 4, projectId: "p1" });
  // In a personal workspace, with no remote, the folder names it.
  await store.saveReview({ targetKey: "ref-2", kind: "ref", gitRef: "main...feat", cwd: "/tmp/scratch", status: "ready", createdAt: 5, projectId: "p2" });
  const { reviews } = await harness.behavior.callRpc("listReviews", null) as { reviews: any[] };
  const byKey = new Map(reviews.map((review) => [review.targetKey, review]));
  expect(byKey.get("ref-1").place).toEqual({ repo: "flosports/api", machine: "MaxBook", path: "/Users/ana/src/api", owner: true });
  expect(byKey.get("pr-3").place).toBeNull();
  expect(reviews.map((review) => reviewIdentity(review).id)).toEqual(expect.arrayContaining(["flosports/api:HEAD", "flosports/api#4512", "acme/api#7", "web#9", "scratch:feat"]));
  // The top-level repo still means a PR.
  expect(byKey.get("ref-1").repo).toBeUndefined();
  const { review } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "ref-1" }) as { review: any };
  expect(review.place).toEqual(byKey.get("ref-1").place);
  expect(reviewIdentity(review).where).toBe("MaxBook · ~/src/api");
});

test("with no local review, nothing is asked of bb for places", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: bbSdk as any });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "flosports/api", number: 4512, title: "Fix login race", status: "ready", createdAt: 2, projectId: "p1" });
  await harness.behavior.callRpc("listReviews", null);
  await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-1" });
  expect(harness.inspection.sdk.callsTo("projects.list")).toHaveLength(0);
  expect(harness.inspection.sdk.callsTo("system.config")).toHaveLength(0);
});

test("a PR's page names its owner as the list does, where only a local review's repository shares its name", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: bbSdk as any });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "ref-1", kind: "ref", gitRef: "HEAD", cwd: "/src/api", status: "ready", createdAt: 1, projectId: "p1" });
  await store.saveReview({ targetKey: "pr-2", kind: "pr", repo: "acme/api", number: 7, title: "Other", status: "ready", createdAt: 3, projectId: "p1" });
  const { reviews } = await harness.behavior.callRpc("listReviews", null) as { reviews: any[] };
  const { review } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "pr-2" }) as { review: any };
  expect(reviewIdentity(reviews.find((listed) => listed.targetKey === "pr-2")).id).toBe("acme/api#7");
  expect(reviewIdentity(review).id).toBe("acme/api#7");
});

test("the list and a review's page give a local review with no title its guide's title, which names it", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: bbSdk as any });
  await plugin(bb);
  const store = testStore(bb);
  await store.saveReview({ targetKey: "ref-1", kind: "ref", gitRef: "main...feat", cwd: "/src/api", status: "ready", createdAt: 1, projectId: "p1" });
  await store.saveGuide("ref-1", { title: "Snooze flaky checks", intent: "I", sections: [], unplacedFiles: [] } as any);
  await store.saveReview({ targetKey: "pr-1", kind: "pr", repo: "flosports/api", number: 4512, title: "Fix login race", status: "ready", createdAt: 2, projectId: "p1" });
  await store.saveGuide("pr-1", { title: "A guide", intent: "I", sections: [], unplacedFiles: [] } as any);
  const { reviews } = await harness.behavior.callRpc("listReviews", null) as { reviews: any[] };
  expect(reviews.map((review) => [review.targetKey, review.guideTitle])).toEqual(expect.arrayContaining([["ref-1", "Snooze flaky checks"], ["pr-1", null]]));
  expect(reviewIdentity(reviews.find((review) => review.targetKey === "ref-1")).line).toBe("api:feat · Snooze flaky checks");
  const { review } = await harness.behavior.callRpc("getReviewBundle", { targetKey: "ref-1" }) as { review: any };
  expect(review.guideTitle).toBe("Snooze flaky checks");
});

test("a folder's review is where its folder is: its repository, machine and path, its bb branch read as its slug", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: bbSdk as any });
  await plugin(bb);
  const store = testStore(bb);
  const feature = { environmentId: "env1", hostId: "host_laptop", machine: "FloMac", path: "/Users/ana/src/web-wt", branch: "bb/snooze-checks-thr_ab12", baseRef: "main", repo: "flosports/web" };
  await store.saveReview({ targetKey: "br-1", kind: "ref", gitRef: feature.branch, title: "Snooze flaky checks", status: "ready", createdAt: 1, projectId: "p1" });
  await store.setLifecycle("br-1", { feature });
  // Its project's remote is another repository's: the folder's own stands.
  const { reviews } = await harness.behavior.callRpc("listReviews", null) as { reviews: any[] };
  expect(reviews[0].place).toEqual({ repo: "flosports/web", machine: "FloMac", path: "/Users/ana/src/web-wt" });
  expect(reviewIdentity(reviews[0])).toMatchObject({ id: "web:snooze-checks", line: "web:snooze-checks · Snooze flaky checks", whose: "Local", where: "FloMac · ~/src/web-wt" });
});
