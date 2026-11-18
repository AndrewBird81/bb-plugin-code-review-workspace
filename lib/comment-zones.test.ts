import { expect, test } from "vitest";
import { githubThreadAt, SUMMARY_AT, type Discussion } from "../src/draft";
import type { ReviewThread } from "../src/threads";
import { buildItems, githubContext, groups, needsYou, shownItems, type CommentSources } from "./comments";

const thread: ReviewThread = {
  id: "T", path: "a.ts", line: 2, side: "RIGHT", isResolved: false, isOutdated: false,
  comments: [{ id: "C", databaseId: 1, author: "sam", body: "Check this.", createdAt: 100 }],
};
const talk = (at = githubThreadAt("T"), createdAt = 100): Discussion => ({
  ...at, waiting: false, entries: [{ kind: "message", author: "agent", body: "Checked.", createdAt }],
});
const sources: CommentSources = {
  draft: { draft: { targetKey: "pr", verdict: "COMMENT", body: "", comments: [] }, stale: [], discussions: [talk()] },
  threads: [thread], feedback: null, sections: [], patch: "", viewer: "me", ownPr: true,
};

test("GitHub discussions attach to threads and PR items, never to private lines or the summary", () => {
  const conversation = (["review", "comment"] as const).map((kind) => ({ id: kind, kind, author: "sam", bot: false, body: "Check the boundary.", at: 100, url: null, waiting: true }));
  const discussions = [talk(), talk(githubThreadAt("review")), talk(githubThreadAt("comment")), talk(SUMMARY_AT)];
  const items = buildItems({ ...sources, conversation, draft: { ...sources.draft!, discussions } });
  expect(items).toHaveLength(3);
  for (const item of items) {
    expect(item.kind).toBe("thread");
    if (item.kind !== "thread") continue;
    expect(item.discussion?.file).toBe(`github:${item.id}`);
    expect(githubContext(item).messages).toEqual([{ who: "@sam", body: item.messages[0].body }]);
    expect(githubContext(item).at).toEqual(item.id === "T" ? { file: "a.ts", line: 2, side: "RIGHT" } : undefined);
  }
  expect(groups(items).find((group) => group.id === "private")!.count).toBe(0);
});

test.each(["thread", "review", "private"])("a newer message reopens a done %s, but the same or older date does not", (kind) => {
  const at = { file: "a.ts", line: 3, side: "RIGHT" as const };
  const id = kind === "private" ? "private:a.ts:3:RIGHT" : kind === "review" ? "R" : "T";
  const read = (latest: number, marked: boolean) => buildItems({
    ...sources, threads: kind === "thread" ? [{ ...thread, comments: [{ ...thread.comments[0], createdAt: latest }] }] : [],
    conversation: kind === "review" ? [{ id, kind: "review", author: "sam", bot: false, body: "Check.", at: latest, url: null, waiting: true }] : [],
    draft: { ...sources.draft!, discussions: kind === "private" ? [talk(at, latest)] : [] },
    doneForMe: marked ? { [id]: { at: 200, latest: 100 } } : {},
  });
  for (const latest of [99, 100]) {
    const items = read(latest, true);
    expect(items[0]).toMatchObject({ id, doneForMe: true, needs: null, group: "done-for-me" });
    expect(needsYou(items)).toEqual([]);
    expect(shownItems(items)).toEqual([]);
    expect(groups(items).at(-1)).toMatchObject({ id: "done-for-me", count: 1 });
  }
  expect(read(101, true)[0].doneForMe).toBeUndefined();
  expect(read(100, false)[0].doneForMe).toBeUndefined();
  if (kind !== "private") expect(needsYou(read(101, true))).toHaveLength(1);
});

test("Done for me follows the newest message in either zone, not an agent's change record", () => {
  const read = (entries: Discussion["entries"]) => buildItems({ ...sources,
    draft: { ...sources.draft!, discussions: [{ ...talk(), entries }] },
    doneForMe: { T: { at: 200, latest: 100 } },
  })[0];
  expect(read([{ kind: "message", author: "agent", body: "New answer.", createdAt: 101 }]).doneForMe).toBeUndefined();
  expect(read([{ kind: "edited", author: "agent", body: "Changed.", createdAt: 101 }]).doneForMe).toBe(true);
});

test("outdated and file threads carry no invented line to the agent", () => {
  for (const more of [{ isOutdated: true }, { subjectType: "FILE" as const }]) {
    const item = buildItems({ ...sources, threads: [{ ...thread, ...more }] })[0];
    if (item.kind !== "thread") throw new Error("Expected a thread");
    expect(githubContext(item).at).toBeUndefined();
  }
});
