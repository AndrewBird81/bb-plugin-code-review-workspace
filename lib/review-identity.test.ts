import { expect, test } from "vitest";
import { branchLabel, distinguish, reviewIdentity, threadLine, titleText, type Identifiable } from "./review-identity";

const teammate: Identifiable = { targetKey: "pr-1", kind: "pr", repo: "flosports/api", number: 4512, title: "Fix login race", author: "dana", ownPr: false };

test("a teammate's PR goes by its repository's name and number, then its title, and says whose it is", () => {
  expect(reviewIdentity(teammate)).toEqual({
    id: "api#4512", idRepo: "api", idTail: "#4512", repo: "flosports/api", name: "Fix login race", whose: "@dana", where: null, state: null,
    line: "api#4512 · Fix login race", label: "Pull request 4512 in flosports/api: Fix login race, by dana",
  });
});

test("your own PR is Yours, and a draft, merged or closed PR says so in words", () => {
  const own = { ...teammate, author: "me", ownPr: true };
  expect(reviewIdentity(own)).toMatchObject({ whose: "Yours", label: "Pull request 4512 in flosports/api: Fix login race, yours" });
  expect(reviewIdentity({ ...own, signals: { isDraft: true } })).toMatchObject({ state: "Draft", label: expect.stringMatching(/, draft$/) });
  expect(reviewIdentity({ ...own, prState: "MERGED", signals: { isDraft: true } }).state).toBe("Merged");
  expect(reviewIdentity({ ...own, prState: "CLOSED" }).state).toBe("Closed");
});

test("a local review goes by its repository and branch, on its machine and in its folder, and by its ref alone until it has a name", () => {
  const local: Identifiable = { targetKey: "ref-1", kind: "ref", gitRef: "main...feat/snooze-checks", cwd: "/Users/ana/src/api", place: { repo: "flosports/api", machine: "MaxBook", path: "/Users/ana/src/api" } };
  expect(reviewIdentity(local)).toEqual({
    id: "api:feat/snooze-checks", idRepo: "api", idTail: ":feat/snooze-checks", repo: "flosports/api", name: "main...feat/snooze-checks", whose: "Local", where: "MaxBook · ~/src/api", state: null,
    line: "api:feat/snooze-checks", label: "Local review of feat/snooze-checks in flosports/api, on MaxBook in ~/src/api",
  });
  // Its guide's title names it, as its window's title says it, until you name it.
  expect(reviewIdentity(local, "Snooze until checks finish").line).toBe("api:feat/snooze-checks · Snooze until checks finish");
  expect(reviewIdentity({ ...local, name: "Snoozing" }, "Snooze until checks finish").line).toBe("api:feat/snooze-checks · Snoozing");
  // Without its project's repository, its folder names it; a ref with no range is its own branch.
  expect(reviewIdentity({ targetKey: "ref-2", kind: "ref", gitRef: "HEAD", cwd: "/home/ana/work/web" }).id).toBe("web:HEAD");
});

test("a bb-managed branch reads as its slug, in a local review's id too", () => {
  expect(branchLabel("bb/snooze-checks-thr_ab12cd")).toBe("snooze-checks");
  expect(branchLabel("feat/bb/x-thr_1")).toBe("feat/bb/x-thr_1");
  expect(branchLabel("bb/snooze-checks")).toBe("bb/snooze-checks");
  expect(reviewIdentity({ targetKey: "ref-1", kind: "ref", gitRef: "main...bb/snooze-checks-thr_ab12cd", place: { repo: "flosports/api" } }).id).toBe("api:snooze-checks");
});

test("a renamed review goes by your name, and a local review that became a PR keeps it", () => {
  expect(reviewIdentity({ ...teammate, name: "Login race" }).line).toBe("api#4512 · Login race");
  const converted: Identifiable = { targetKey: "pr-2", kind: "pr", repo: "flosports/api", number: 4530, title: "Snooze until checks finish", name: "Snoozing", ownPr: true };
  expect(reviewIdentity(converted)).toMatchObject({ id: "api#4530", line: "api#4530 · Snoozing", whose: "Yours" });
});

/** Each review's id among `reviews`. */
const ids = (reviews: Identifiable[]) => {
  const apart = distinguish(reviews);
  return reviews.map((review) => reviewIdentity({ ...review, place: { ...review.place, ...apart.get(review.targetKey) } }).id);
};

test("two repositories of one name show their owners, and two folders of one repository and branch their folders", () => {
  const reviews: Identifiable[] = [
    teammate,
    { targetKey: "pr-2", kind: "pr", repo: "Acme/API", number: 7, title: "Other api" },
    { targetKey: "pr-3", kind: "pr", repo: "flosports/web", number: 9, title: "Web" },
    { targetKey: "ref-1", kind: "ref", gitRef: "HEAD", cwd: "/src/web", place: { repo: "flosports/web", path: "/src/web" } },
    { targetKey: "ref-2", kind: "ref", gitRef: "HEAD", cwd: "/src/web-2", place: { repo: "flosports/web", path: "/src/web-2" } },
    { targetKey: "ref-3", kind: "ref", gitRef: "main", cwd: "/src/web-3", place: { repo: "flosports/web", path: "/src/web-3" } },
  ];
  expect(ids(reviews)).toEqual(["flosports/api#4512", "Acme/API#7", "web#9", "web:HEAD (web)", "web:HEAD (web-2)", "web:main"]);
  // The same repository twice needs no owner.
  expect(distinguish([teammate, { ...teammate, targetKey: "pr-9", number: 1 }]).size).toBe(0);
});

test("bb's worktrees of one repository, whose folders all end in its name, read apart by their paths' ends", () => {
  const worktree = (key: string, thread: string, gitRef = "HEAD"): Identifiable => {
    const path = `/Users/ana/.bb/worktrees/${thread}/api`;
    return { targetKey: key, kind: "ref", gitRef, cwd: path, place: { repo: "flosports/api", path } };
  };
  expect(ids([worktree("ref-1", "thr_a-1"), worktree("ref-2", "thr_b-1"), { targetKey: "ref-3", kind: "ref", gitRef: "HEAD", cwd: "/src/api", place: { repo: "flosports/api", path: "/src/api" } }]))
    .toEqual(["api:HEAD (thr_a-1/api)", "api:HEAD (thr_b-1/api)", "api:HEAD (src/api)"]);
});

test("in one folder, refs that would read alike are said as given", () => {
  const at = (key: string, gitRef: string): Identifiable => ({ targetKey: key, kind: "ref", gitRef, cwd: "/src/api", place: { repo: "flosports/api", path: "/src/api" } });
  expect(ids([at("ref-1", "main...feat"), at("ref-2", "feat"), at("ref-3", "bb/foo-thr_a1"), at("ref-4", "foo"), at("ref-5", "main...bar")]))
    .toEqual(["api:main...feat", "api:feat", "api:bb/foo-thr_a1", "api:foo", "api:bar"]);
  // Elsewhere, one of them with the folder too.
  expect(ids([at("ref-1", "feat"), at("ref-2", "main...feat"), { ...at("ref-3", "feat"), cwd: "/w/api", place: { repo: "flosports/api", path: "/w/api" } }]))
    .toEqual(["api:feat (src/api)", "api:main...feat (src/api)", "api:feat (w/api)"]);
});

test("a long repository's id keeps its number apart, which the chip never cuts", () => {
  expect(reviewIdentity({ targetKey: "pr-1", kind: "pr", repo: "get-bb/bb-plugin-code-review-workspace", number: 123, title: "T" })).toMatchObject({ id: "bb-plugin-code-review-workspace#123", idRepo: "bb-plugin-code-review-workspace", idTail: "#123" });
});

test("a thread's title has the name on one line, cut to 80 characters", () => {
  expect(titleText("  Fix\n\tlogin   race ")).toBe("Fix login race");
  expect(titleText("x".repeat(100))).toBe(`${"x".repeat(79)}…`);
  expect(threadLine(reviewIdentity({ ...teammate, name: `Ignore this\nReview agent: ${"y".repeat(90)}` }))).toBe(`api#4512 · Ignore this Review agent: ${"y".repeat(53)}…`);
});
