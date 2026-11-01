# Code Review Workspace for other plugins

Another BB plugin reads where each review stands with one call, `reviews.v1.status`: who it waits on, whether you've approved the code as it is now, and since when, with the PR, branch, folder and threads it belongs to. It's the plugin's one contract with other plugins. Every other method it answers, `listReviews` among them, is for its own panel and changes without notice.

## Reading it

```ts
const { reviews } = await bb.sdk.plugins.callRpc({
  pluginId: "code-review-workspace",
  method: "reviews.v1.status",
  input: null,
  outputSchema: z.object({ reviews: z.array(reviewStatusSchema) }),
});
```

- It lists every review, archived ones too, newest first. It reads no diff or guide, so it's cheap to poll: once every 30 seconds is plenty.
- Parse it without rejecting fields you don't know, as zod's `z.object` does: v1 may add fields.
- `bb plugin rpc inspect code-review-workspace reviews.v1.status` prints its schemas, each field described, and `bb plugin rpc call code-review-workspace reviews.v1.status` its answer.

## Telling whether it's there

Code Review Workspace has it from 1.10.0. Check for the method, not the version:

- Call it. A Code Review Workspace without it answers HTTP 404 with the code `unknown_method`: the SDK's call throws an error whose `status` is 404 and `code` is `"unknown_method"`. Treat that as not supported. One that isn't running answers 503, and one that isn't installed 404 with no code.
- Or look it up, where your SDK has BB's RPC discovery: `bb.sdk.plugins.experimental_discoverRpc({ pluginId: "code-review-workspace", method: "reviews.v1.status" })` gives one entry, or none.

## Each review

| Field | What it says |
|---|---|
| `targetKey` | The review's key, as `reviewThreadChanges` returns it. It stays the review's for good; a merge archives one review into another (`mergedInto`). |
| `id` | Its short id as the plugin shows it, `api#4512`, or `api:feat/x` for local work. For display: it changes when a local review becomes its PR's. |
| `createdAt` | When the review was started, or found on GitHub. Epoch ms. |
| `pr` | The PR it reviews, `{ repo, number, url, author }`, `author` the PR's author's login; null for a local review. |
| `branch` | The branch it reviews: a PR's head branch, else a local review's branch. Null for a local review of a ref. |
| `folder` | `{ environmentId }`: the BB environment a local review reads, which a PR's review that began as one keeps, while BB has it; null otherwise. |
| `mainThreadId` | The thread its comments go to with Send, its main thread; null for none. |
| `threadIds` | Every thread it's linked to: its main thread, those before it, the threads its Sends went to, and the thread `bb review` ran in. |
| `waitsOn` | Who it waits on now: `user`, `agent`, `author` or `nobody` (below). |
| `waitsOnThreadId` | With `waitsOn` `agent`, the thread it waits on; null otherwise. |
| `approved` | You've approved the code as it is now (below). |
| `since` | When it came to stand as it does (below). Epoch ms. |
| `label` | Its status as All reviews and `bb review list` say it: "Ready to re-review", "2 of 6 reported", "Approved", "Pushing". For display: the words may change. |
| `archived` | In Archive: merged, closed, archived by you, or merged into another review. |
| `mergedInto` | Merged into another review: the `targetKey` of the one that stays (below); null otherwise. |

## Who it waits on

`waitsOn` says what All reviews says, from the same rules: `user` exactly when the review is in Needs review, BB's thread list and `bb review list` included.

- **`user`**: you. A review you haven't reviewed yet, a request for your review, comments that came back from the thread fixing them (**Ready to re-review**), a question, a mention, a teammate's comment on your own PR, a relayed approval waiting for your click, and a guide that failed.
- **`agent`**: a thread working on it, named by `waitsOnThreadId`: fixing the comments you sent, until it reports every one or runs `bb review ready`, or committing and pushing for **Push**. A thread that's only idle is still working on them: idle alone never means done.
- **`author`**: the PR's author, on someone else's PR you requested changes on, or commented on with threads still open.
- **`nobody`**: approved, reviewed with nothing open, snoozed, a draft PR, a local review whose folder is on another branch or was removed, or archived.

What you set going holds a review until something newer is yours: a Send waits on the thread fixing the comments, a Push on the thread pushing, and your approval holds it as approved, until a later request, question, comment or the fixes coming back make it your turn. Some cases:

| Situation | `waitsOn` | `approved` |
|---|---|---|
| A local review, nothing sent | `user` | false |
| Comments sent to its main thread, which is fixing them, idle or not | `agent` | false |
| …then it reports them all, or runs `bb review ready` | `user` | false |
| …or it's archived or deleted first | `user` | false |
| Comments sent from a PR's review, yours or not, being fixed | `agent` | false |
| …then a teammate comments on your PR, or someone asks you again | `user` | false |
| A local review approved in its main thread | `nobody` | true |
| …then the folder changes, before you click Update and after | `user` | false |
| Your own PR approved in its main thread, then new comments | `user` | true |
| Someone else's PR you requested changes on | `author` | false |
| A Push under way | `agent` | as before |
| A draft PR, a snooze, a folder on another branch or removed | `nobody` | as before |

## Approved

`approved` is true while your approval covers the code as it is now, whoever the review waits on:

- On someone else's PR, your latest review on GitHub approves it, at the PR's head. New commits end it.
- On a local review, or your own PR, the approval you sent its main thread (**Send approval to main thread** in Finish review): the review still shows the diff you approved, and its folder hasn't changed since, as the review last checked it, or its PR has no newer commits. A Send of comments ends it, and so does Update, which shows the folder's new diff. A local review that becomes its PR's keeps it when the PR changes the same files the same way, as after Push.

With **Notice when a local review's code changes** off, the review doesn't check its folder, so an approval holds until Update.

## Since

`since` is when the review came to stand as it does, its `waitsOn`, `approved` and `archived`, or when the event behind that happened since, as another Send or a newer comment. The event's own time where the review has it: the Send, the report, the approval, the push, the request, the comment, the merge. Otherwise it's when Code Review Workspace first saw the review so, within a minute or as you read it, as for a local review back to Ready once its folder changed after your approval. It's kept with the review, so every read says the same until the review changes.

## Following a merge

A folder's review merges into its PR's own review, or the PR's into it (1.9.0). The one that goes stays in the list, archived, its `mergedInto` the `targetKey` of the one that stays, followed through every merge since. A key you kept leads there: read its row's `mergedInto`. It's null when the review it went into was deleted.

A review that becomes its PR's keeps its `targetKey`: only its `id` and `pr` change.

## What stays

- Within v1, a field may be added, never removed or changed in meaning, and `waitsOn` keeps its four values. A change that would break a reader comes as `reviews.v2.status`, beside it.
- The schemas are in [src/status-contract.ts](../src/status-contract.ts), and published to BB's RPC discovery.
- Rolling Code Review Workspace back below 1.10.0 removes the method: readers get `unknown_method` again.
