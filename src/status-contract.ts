import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// What other plugins read of the reviews (docs/plugin-api.md), published so BB's RPC discovery lists it: the plugin's
// one contract with them. Within v1 a field may be added, never removed or changed in meaning, and `waitsOn` keeps its
// four values; a change that would break a reader comes as v2, beside it. src/rpc-contract.ts is the plugin's own, for
// its panel, and changes without notice.

/** The method's name, by which a plugin calls it or finds it with BB's RPC discovery. */
export const REVIEW_STATUS = "reviews.v1.status";

const reviewStatus = z.looseObject({
  targetKey: z.string().describe("The review's key, as reviewThreadChanges returns it. It stays the review's for good; a merge archives one review into another (mergedInto)."),
  id: z.string().describe("Its short id, as Code Review Workspace shows it: api#4512, or api:feat/x for local work. For display: it changes when a local review becomes its PR's."),
  createdAt: z.number().int().describe("When the review was started, or found on GitHub. Epoch ms."),
  pr: z.object({
    repo: z.string().describe("owner/name"),
    number: z.number().int(),
    url: z.string(),
    author: z.string().nullable().describe("The PR's author's GitHub login."),
  }).nullable().describe("The PR it reviews; null for a local review."),
  branch: z.string().nullable().describe("The branch it reviews: a PR's head branch, else a local review's branch. Null for a local review of a ref."),
  folder: z.object({ environmentId: z.string().describe("BB's environment for the folder.") }).nullable()
    .describe("The folder a local review reads, which a PR's review that began as one keeps, while BB has it; null otherwise."),
  mainThreadId: z.string().nullable().describe("The thread the review's comments go to with Send, its main thread; null for none."),
  threadIds: z.array(z.string()).describe("Every thread the review is linked to: its main thread, those before it, the threads its Sends went to, and the thread bb review ran in."),
  waitsOn: z.enum(["user", "agent", "author", "nobody"]).describe("Who it waits on now. user: you, as All reviews' Needs review lists it. agent: a thread working on it, fixing the comments you sent until it reports them all or runs bb review ready, or committing and pushing for Push; idle alone isn't done. author: the PR's author, on someone else's PR you requested changes on, or commented on with threads open. nobody: approved, reviewed, snoozed, a draft PR, a folder on another branch or removed, or archived."),
  waitsOnThreadId: z.string().nullable().describe("With waitsOn agent, the thread it waits on; null otherwise."),
  approved: z.boolean().describe("You've approved the code as it is now: on someone else's PR, your review on GitHub at the PR's head; on a local review or your own PR, your approval sent to its main thread, while the review shows the diff you approved and its folder and PR haven't moved on. Whatever it waits on: your approved PR may get new comments."),
  since: z.number().int().describe("When it came to stand as it does, waitsOn, approved and archived, or the event behind that since, as a later Send: the event's time where the review has it, else when Code Review Workspace first saw it so. Epoch ms."),
  label: z.string().describe("Its status as All reviews and bb review list say it: Ready to re-review, 2 of 6 reported, Approved, Pushing. For display: the words may change."),
  archived: z.boolean().describe("In Archive: merged, closed, archived by you, or merged into another review."),
  mergedInto: z.string().nullable().describe("Merged into another review: the targetKey of the one that stays, through every merge since; null otherwise, or when that one was deleted."),
});

export const statusContract = defineRpcContract({
  [REVIEW_STATUS]: {
    experimental_description: "Every review, archived ones too, newest first: who it waits on, whether you've approved the code as it is now, since when, and the PR, branch, folder and threads it belongs to. Cheap to poll: no diff or guide is read.",
    input: z.object({}).strict().nullable(),
    output: z.looseObject({ reviews: z.array(reviewStatus) }),
  },
});
