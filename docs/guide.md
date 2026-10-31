# Code Review Workspace guide

Everything Code Review Workspace does, in the order you'll meet it. For what it is and how to install it, start with the [README](../README.md).

Two agents work on each review. The **guide writer** is a hidden agent that writes the chaptered guide (**Guide writer agent** in Settings). The **review agent** drafts comments, the summary, and a suggested verdict, answers you in **Ask agent**, and does review work on GitHub when you ask (**Review agent** in Settings).

- [Install and first run](#install-and-first-run)
- [Updates](#updates)
- [What carries over from Guided Review](#what-carries-over-from-guided-review)
- [Local changes and the command line](#local-changes-and-the-command-line)
- [The review workspace](#the-review-workspace)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Phone and iPad](#phone-and-ipad)
- [Whose turn](#whose-turn)
- [Comments and Finish review](#comments-and-finish-review)
- [Customize your reviews](#customize-your-reviews)
- [Data and access](#data-and-access)
- [Upgrading from older versions](#upgrading-from-older-versions)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)

## Install and first run

Install Code Review Workspace from its Git repository; the range follows compatible 1.x releases:

```sh
bb plugin install git:github.com/AndrewBird81/bb-plugin-code-review-workspace@^1.0.0
```

1. Open **Code Review Workspace**. With no reviews yet, **All reviews** checks your setup and says how to start; you can revisit it in **Settings → Ready to review**.
2. Sign in on the BB server with `gh auth login --hostname github.com`. Check the account displayed in Code Review Workspace and its access to the repository. No token is pasted into the plugin.
3. Paste a GitHub PR link into the box on **All reviews** and choose **Review**, or press Enter. Your BB agent writes the chaptered guide using its normal usage allowance. When the guide is ready, the review agent reviews the change, adds draft comments, and writes a review summary with the verdict it suggests. On PRs from outside your repository's members and collaborators, or whose branch is in someone else's fork, agents wait for your click (see [Who agents run for on their own](#who-agents-run-for-on-their-own)).
4. The review opens on its Overview; **Start reading** takes you through the chapters. Edit or remove the agent's draft comments and summary, or ask it to change them, add your own, or ask the agent about a file or selection.
5. Open **Finish review**, choose a verdict, and **Submit to GitHub**, or ask the review agent to submit it and click **Post** (see [Posting when you ask](#posting-when-you-ask)). Drafting and generating never submit a review. Replies and resolve actions on existing GitHub threads are separate, immediate actions.

GitHub accounts:

- Switching the GitHub account affects `gh` on the BB server.
- Environment tokens can override saved-account selection; the plugin reports when a switch has not taken effect.
- Review submissions verify the displayed account and use its credential for the entire request.

## Updates

Open **Settings → Plugin updates** to check for a compatible release, read its release notes, and choose **Update now**. Save or discard settings edits and close other Code Review Workspace pages first. BB installs the latest compatible release available at installation time; it may advance beyond the version shown by an earlier check.

**Automatic updates are off by default.** With **Update automatically when idle** on:

- The plugin checks hourly after five idle minutes.
- It waits until all Code Review Workspace and Settings pages are closed, with no generation, save, or submission in progress.
- Review agent conversations run in BB and continue across plugin updates. Reviews, drafts, private notes, conversations, and preferences remain in BB.
- Failed checks are visible and retried later; BB handles failed-install rollback.

Installs from a Git range, such as `^1.0.0`, follow its compatible releases (1.x). You can also update with `bb plugin update code-review-workspace`; close the plugin's pages first, since BB's external update command does not use the in-plugin activity guard. Local directories and exact tags are pinned and do not receive automatic updates.

Moving a local-directory install to a Git source, and an updater that still asks you to close pages after they're all closed: see [docs/operations.md](operations.md#updates).

## What carries over from Guided Review

The steps to move are in the README's [Moving from Guided Review](../README.md#moving-from-guided-review). The first time Code Review Workspace starts, it copies in Guided Review's reviews, guides, drafts, private notes, and settings, as long as it has none of its own yet, and the review agent's conversations carry on with Code Review Workspace's tools.

What doesn't carry over: the small state kept outside the plugin's database. An alert already in Needs You stays Guided Review's, and one still waiting to be sent is dropped; what happened on your PRs before the move counts as history, as when a review starts being followed, so it doesn't make a review your turn again. The copy runs once, at Code Review Workspace's first start: what Guided Review changes after that stays in Guided Review, which is why step 2 comes first.

## Local changes and the command line

Run `bb review` in a BB thread. With nothing after it, it reviews the folder that thread works in, on any machine. A PR URL, or `owner/repo#n`, works from a thread on any machine; a PR number or a local ref needs a project checkout on the BB server:

```sh
bb review                              # this thread's folder: its branch's changes, uncommitted and new files included
bb review https://github.com/acme/web/pull/42
bb review acme/web#42                  # the same PR
bb review 42                           # PR in the current repository
bb review origin/main...HEAD           # local range
bb review my-feature --base main       # branch against main
bb review https://github.com/acme/web/pull/42 --context 'Implements LIN-123: retry once, never twice.'
```

`bb review` must run in a project thread, and a review it starts runs in that thread's project.

### A thread's folder

`bb review` with no PR or ref reviews the folder the thread works in, on whichever machine it's on: everything its branch changed against its base, committed, uncommitted and new files alike. The base is the branch's PR's base once it has one, else the one BB keeps for the folder.

- There's one review per folder and branch, however many threads and subagents work there. Run again, from any of them, it opens the review as it is: nothing is rebuilt.
- **Review changes**, above a thread's message box in BB, after Changed files, does the same from the thread's page, while the folder has changes. For a thread linked to a review, the one its Review tab shows, whatever its folder, it reads "Review · 2 open ↗", or "Review ↗" with nothing open, and goes straight to that review, as **Main thread ↗** on the review comes back; its tooltip says the switch's key. Otherwise a click starts the folder's review. **Review changes above a thread's message box** in Settings → Reading hides it. The plugin's own agents' threads don't get it.
- A thread linked to a review, its main thread, a thread a Send went to, or a thread working in its folder, gets a **Review** tab beside its chat: the review's id and name, **Review ↗**, which goes to the review, its comments, each saying where it stands, which open the review at that comment, and the review agent's chat. Before it has one, its first message's box is there, choosing the agent: you ask without leaving the thread. The tab reads no git, and stays with Review changes off.
- The review is addressed to its main thread, the top thread working in that folder, which gets the comments you send. A subagent's call finds the thread that leads the work, even under an orchestrator in another folder; a live thread replaces an archived main thread, but not one BB can't read just then. The command says which.
- It's named after the main thread, until its branch has a PR. Its id is the repository and branch, `api:snooze-checks`, and it shows the machine and folder.
- New files that look like secrets (`.env*`, `*.pem`, `*.key`, `credentials*`), binaries and very large diffs stay out of the review and away from agents; a button naming each secret sends it to agents, and **Include** brings binaries in. Committed ones that look like secrets show, flagged, until you choose **Got it**.
- The notice strip says when the folder changed, "3 files changed since your last update.", with **Update**, which shows the new code with your comments moved to their lines and keeps the guide (unless **Notice when a local review's code changes** is off). After an Update that showed new code, it says "The guide was written before your last Update." (or, after Include, "…before you changed which files are shown."; on a PR's review, after your Push lands, "…before the PR’s latest commits."; and once the review becomes its PR's, if the PR's diff isn't the local changes, "The guide was written for the local changes, before the PR.") with **Rewrite guide**, which starts the guide writer; the notice stays until a new guide is accepted, and goes once the folder's removed or the review's archived. It also says when the folder is on another branch, which pauses the review until it's back, with **‹branch› review ↗** where that branch has one, or else, for a branch made from it, "Folder moved to `feat/x-v2`, a new branch. This review stays with `feat/x`.", with **New review for it** and **Follow it instead**, which keeps this review on it; a branch renamed, the old one gone and the review's last commit on the new one, it follows on its own, "Now following `feat/nice`. It was `api:feat/qa`, which still opens it.", and the old branch's next review gets a key of its own; when its machine is offline, keeping the folder as last read; when BB removed the folder; and which other threads are also editing it.
- Once its branch has an open PR, a draft one or one under the name a thread in the folder pushed it as since the review began (`git push origin HEAD:feat/nice`, `gh pr create --head feat/nice`), the same review becomes the PR's, within seconds whoever opens it: a thread in the folder that pushes, by `git push`, `git -C <dir> push`, `jj git push` or `gh stack push` or `submit`, or runs `gh pr create` has it checked at once, but while GitHub limits reads, Push finds it when the main thread stops, every local review is looked for in one request every 2 minutes, and an open review asks every 30 seconds. Its diff is the PR's at its head, and your comments are kept: onto the PR's lines, **Not on GitHub yet** where only the folder has the line, and the rest kept on the older diff, open ones under **Needs you**. Its notice says so until **Got it**: "Now PR #4512's review, `api#4512`, with 6 comments carried over, 2 not on GitHub yet. 1 is on a line the PR doesn't have, under Needs you. It was `api:snooze-checks`, which still opens it.", with **PR #4512 ↗**; its **Needs you** opens Comments there. After a merge it says what moved, with **Earlier agent chat ↗**, which opens the merged review's agent chat beside the review. A PR opened before the review, or from another branch, as a stacked branch's upstream before its first push, "PR #12 is from `part1`, not this branch.", waits for **Make it PR #12's review** or **Not this one**, and nothing merges before it; after **Not this one** it waits for that click alone, which **Review actions** (⋯) still offers.
- The review agent is told without a turn of its own: its instructions name the PR, the next message the review sends it or its review tools' next answer says so once, and its thread takes the PR's id.
- If the PR already has a review of its own, the two merge: at once when the one that goes has nothing of yours, else from **Merge into one review**, the same on both reviews, whose notice says which stays: "PR #4512 has its own review, with 3 comments and a summary. Merging keeps this one and archives that one.", beside **PR #4512's review ↗**, or on the PR's review "This PR's branch has a local review with 1 comment. Merging keeps that one and archives this one." beside **Local review ↗**. **Keep both** stops both offering: the folder's review stays local, and the PR's review stays the PR's. While neither is archived, **Review actions** (⋯) on either still offers **Merge into one review**, its line saying which stays, "PR #4512 has its own review. Merging keeps this one and archives that one." Comments follow their lines with their ids and Sends, a clashing one going into the summary, a tracked one's discussion going on in the summary's, and the summary, notes, Sends and viewed files join. The one merged away is in Archive as "Merged into `api#4512`", and opening it, by its link, key or id, opens the review it went into. A second folder on the branch merges into the first's.
- The PR's review keeps the folder while it's there on its branch: "3 files on MaxBook aren't on GitHub yet." with **Review them**, which opens [Not pushed yet](#feedback-on-your-own-pr); **Open in editor** opens files in the folder, on its machine, at a line only in files the folder hasn't changed since the PR's head. When the PR has new commits, **Update**, beside Update guide, takes the PR's head without the guide writer, the comments moving with their lines and the guide saying it's older, with **Rewrite guide**; a Push that lands on the commit it checked does it on its own.
- `bb review` on a branch used again after its PR merged, or closed and went to Archive, starts a new review, not the PR's old one.
- **Push and open PR**, in Finish review on a local review whose branch has no PR, pushes as **Push** does, then has the review agent draft the PR for you to post; **Push only** beside it just pushes. Once the draft waits in the agent's chat, Finish says "The PR draft is ready." with **Post PR…**, which opens the **Review agent** tab, where you post it; where Finish isn't showing, a toast says so once, with the same button. If the agent couldn't be asked, Finish says why, with **Try again**. While the draft waits, or after that, **Push** shows only while the folder has something new to push. With **Let the review agent act when you ask** off, it's Push, and once pushed, **New PR on GitHub ↗**. While comments aren't sent yet, **Send N to main thread** is the filled button, and Push says "1 comment isn't sent yet. Send it first, or push anyway.": it warns, and never stops you.
- **Open PR**, in Finish review on its own for a branch on GitHub with no PR (or "open a PR" to the review agent), has the agent draft the PR's title and description and show them in the Post form, from the branch into its base, as you; its **Open PR** opens it on GitHub, and the review becomes the PR's: its id changes from `api:snooze-checks` to `api#4512` everywhere, and a notice says so. The branch must be on GitHub first: until it's pushed, Open PR says to use **Push**. A branch with a PR already makes the review that PR's instead; a fork's folder opens its PR on GitHub.
- When BB removes the folder, a review that became a PR's goes on. A local one goes to Archive, unless comments are open or sent.
- A review's own agent can't start one, and `--base` goes only with a ref.

### What each form reviews

- **A single ref**, such as `bb review main`, runs `git diff main`: your working tree against the ref, uncommitted changes to tracked files included.
- **A range**, such as `origin/main...HEAD` or `a..b`, runs `git diff` on that range, as git reads it: `...` starts at the merge base. It covers committed changes only.
- **A ref with `--base`**, such as `bb review my-feature --base main`, runs `git diff main...my-feature`: what the branch changed since it left main, committed changes only.
- **Untracked files are never included** in a ref's review. To review a new file, track it first, for example with `git add -N <file>`, or review the thread's folder with `bb review` alone.
- `--base` goes with a single ref: `bb review` refuses it beside a range.

A local ref's checkout must exist on the BB server; for a folder on another machine, run `bb review` with no ref in its thread. Local reviews do not offer GitHub submission.

- When you open a local review, it runs its diff again in the checkout, and if the code changed since its guide, the notice strip says "The code changed." with **Update**, which shows the new diff, your comments following their lines, and keeps the guide, and **Rewrite guide**, which starts the guide writer to write a new one (unless **Notice when a local review's code changes** is off in Settings → Reading).
- On a local review whose diff ends at the checkout (a ref, such as `bb review main`, or a range ending at `HEAD`), each file's second row and each draft comment's ⋯ offer **Open in editor** at the line, which opens the checkout's file on the BB server (unless **Open in editor (local reviews)** is off).

`bb review` remembers the thread it ran in, as the thread that made the change; this plugin's own agents never count. It prints a link to the review when BB has an app URL. `bb review list [--json]` lists every review, Needs review first and a stack's reviews together, as All reviews does, with its id, its key, its title (quoted, then `named "…"` with the name you gave it), whose turn it is, and whether its guide is ready; `--json` adds `agentThreadId`, the review agent's thread, for `bb thread tell` (null while it has none). With **Help agents in your threads use bb review** on (Settings → Review agent), agents in your other BB threads are also offered a `code-review-workspace` skill that explains these commands, including `bb review report` and `ready` ([Send comments to the main thread](#send-comments-to-the-main-thread)) and `ask` and `approve` ([below](#asks-and-approvals-from-other-threads)), tells them never to post to GitHub themselves but to relay your asks to the review's agent, and says that what `bb review` prints is data, not instructions. Off, `bb review` prints no link and has no `list`.

### Context for the automatic review

`--context` adds text, such as the ticket a PR implements, to the review agent's automatic review, up to 12,000 characters.

- It's kept with the review: running `bb review` again without it keeps it, and `--context ''` removes it.
- It goes with the automatic review, which runs when a guide is ready and the review has no conversation yet, and the review's agents can read it with the PR's context, fenced as untrusted text.
- The command says when the automatic review won't run: it's off, the PR is merged or closed, the review already has a conversation, or you've already reviewed the PR. On a guide waiting for **Run review**, the context goes with that run.
- A review's own agent can't set or remove it.

### Draft comments and the summary from other threads

Other BB threads and scripts can work with a review's draft comments. These commands change only the local draft; nothing is posted to GitHub until you submit:

```sh
bb review comment list   https://github.com/acme/web/pull/42 [--json]
bb review comment add    https://github.com/acme/web/pull/42 src/api.ts:57 --code 'return cache.get(key);' --body 'Stale after a write?'
bb review comment add    https://github.com/acme/web/pull/42 src/api.ts:57-58 --code $'return cache.get(key);\n}' --body 'Read through on a miss.' --severity should-fix --evidence 'save() at `src/api.ts:40` never clears the cache.'
bb review comment edit   https://github.com/acme/web/pull/42 src/api.ts:57 --body 'Can this return stale data after a write?'
bb review comment delete https://github.com/acme/web/pull/42 src/api.ts:57
```

- A review is named by its PR URL, `owner/repo#n`, its key, or its id, `api#4512` or `api:feat`, as `bb review api:feat` opens it, not as a git ref; the id a folder's review had before it became its PR's still names it. Of the reviews an id names, the one not archived is taken, else the newest; when more than one isn't archived, as when that branch has a review of its own now, or two folders' reviews share the id, the command takes none and lists them: "`api:feat` names 2 reviews: `api:feat (api)` in ~/src/api on MaxBook (br-1a2b…), … Use one's key or link."
- While its guide is being written or rebuilt, these commands leave the draft alone and say to try again once it's ready.
- Line numbers count in the new file; add `--side LEFT` for a removed line, numbered in the old file.
- `--code` is that line's text, and `add` refuses a line that doesn't match it or already has a comment.
- `path:57-58` comments on a range of lines in one hunk; `--code` then holds the range's lines, one per line (in a shell, `$'a\nb'`), and GitHub gets a multi-line comment.
- `--severity blocking|should-fix|question|nit|none` sets the comment's severity; a body that starts with a label, such as `**Blocking:**`, sets it too.
- `--evidence` says how the problem was confirmed, what was read or run, with file:line, in up to 600 characters; the card folds it under **How the agent checked**, and it's never posted.
- `--pre-existing` marks a problem in code the PR didn't change (see [Severity, Undo, and pre-existing problems](#severity-undo-and-pre-existing-problems)); `edit` without it keeps the comment's mark.
- `--body` takes up to 65,000 characters, GitHub's limit.
- `list` shows each comment's range and severity.
- Comments added this way show as added by an agent.
- A review's own agent, its review agent or guide writer, can use these commands only on its own review.

The review summary works the same way. `--suggest` marks the verdict you'd suggest; the reviewer still picks it. A summary the reviewer wrote is refused, unless they asked on it:

```sh
bb review summary https://github.com/acme/web/pull/42 [--json]
bb review summary https://github.com/acme/web/pull/42 --body 'One blocker: the retry can double-charge (`src/pay.ts:88`).' --suggest REQUEST_CHANGES
```

### Asks and approvals from other threads

Your other threads can relay what you ask to a review's agent, and line approvals up for your click:

```sh
bb thread tell <agentThreadId> 'Comment that CI is flaky.'   # agentThreadId from bb review list --json
bb review ask acme/web#42 'Comment that CI is flaky.'        # starts the review's agent if it has none
bb review approve acme/web#42 acme/web#43 --body 'LGTM'
```

- The agent answers the thread that asked, and posts as [Who's asking](#whos-asking-and-the-approval-rule) says.
- An approve, merge or close asked this way, or with `bb review approve`, never posts. It waits in **Needs review** under **Ready to approve**: "Approve · `web#42` · LGTM", with exactly what posts, as which GitHub account, "Asked from ‹the thread›", which opens it, and **Approve** and **Dismiss**. **Approve 3** posts each approval shown in turn, the verdict and summary alone, leaving the draft's comments in the draft, each row saying how it went; a merge or close takes its own click. Then "Approved 3 on GitHub", with links, stays at the top of Needs review until you dismiss it. A row waiting doesn't quiet the review's own alerts: a new comment on your PR still alerts, and the row says "2 new comments on your PR, the latest since this was asked", and a snooze still ends.
- A PR with commits since you read it is held, by what the sync knows and by GitHub's head as each posts: "Held: 2 new commits since you read it. Approving covers them too." **Approve it too** posts it on the commit you read; "2 held: commits since you read them · **Approve them too**" posts every held one.
- A review's own agents, and threads they start, can't use `bb review ask` or `bb review approve`, and a message from any of them counts as no one's (see [Who's asking](#whos-asking-and-the-approval-rule)).

## The review workspace

### Layout

- The code first. A review's commands sit in BB's **Code Review Workspace** title bar: **Comments**, with a badge counting what needs you; **Ask agent**; with a main thread, **Main thread ↗**, which goes to it, its ↗ there however narrow the bar, and **Show beside review**, two columns, which shows its chat in BB's side panel, or hides it; **Finish review**, with the verdict and how many comments will be sent, or on a local review, which submits nothing, how many open comments Send would send; **Review actions** (⋯); and **Full screen**.
- Over the code is one 44px band: the chapters toggle and **Find in review** while the chapters aren't docked (docked, they head the chapters), **‹ All reviews**, the chapter you're on with its progress ring, the compare select on a re-review, **Fold comments**, and **Diff options**.
- **Full screen** covers BB's bars, on an iPhone too; the band then ends with the review's commands, and toasts, **Undo** among them, show over it. A phone has no band: see [Phone and iPad](#phone-and-ipad).
- The review agent and the main thread are tabs in BB's own side panel, at the window's right, as on a thread's page: see [The review agent](#the-review-agent) and [Send comments to the main thread](#send-comments-to-the-main-thread). Beside it, a review under 600px wide keeps BB's title bar and the band, down to 480px, with its commands as icons, except on a phone's touch screen. Mid-width, **Main thread ↗** keeps its label and **Ask agent** is its icon. While either chat shows, BB's toasts sit above its message box.
- The chapters and the review's own panel (Comments or Finish review) dock beside the code while it keeps at least 560px; otherwise they slide over it, and Esc, a tap on the code, ✕, or choosing something closes them. The panel docks narrower, down to 320px, before it covers the code. With no room for both, the chapters wait while the panel is docked and dock again when it closes.
- Drag the line between a side and the code to resize it; double-click or double-tap it for the default width. Widths are kept for every review.

### The Overview

A review opens on its **Overview** the first time, and whenever it comes back to you (unless **Open on the Overview when a review comes back** is off in Settings → Reading). Otherwise a review reopens where you left it, scroll position included. The Overview holds:

- The title, which opens the PR (your name for the review, once you've [renamed](#rename) it, with the PR's title under it); the author, repository, and branches; the changed lines to read with a rough reading time ("about 4 h to read", in days past 24 hours; about 400 lines an hour, without lockfiles and generated files).
- A status line in All reviews' words (whose turn, **Blocks merge**, your feedback's progress, checks); your earlier reviews and the stack.
- **Start reading**, **Continue** where you were, or **Review changes** at the first chapter that changed since your review, with **Snooze** while it's your turn.
- **Since your review**.
- **What and why**, which ends with a line when the PR changes a file the agents read for the repo's rules ("This PR changes CLAUDE.md, which the agents read; they use the base version.").
- **Start here**, the guide's one to three riskiest lines, each opening its line, a removed line on the diff's old side.
- **Requirements · 3 of 4 covered**, what the PR's description and linked tickets ask for and whether the diff does it, with evidence and a link to the line (Settings → Reading can hide it).
- Failing and pending checks with **View check**, and **Ask agent** on a failing GitHub Actions check, which reads the end of its failed log and quotes it into the agent's box, unsent.
- The chapters.

When the review came back to you, Comments opens on what needs you where it can sit beside the code in BB's pane, or a "3 need you" pill offers it until you scroll.

### Chapters

- Ordered chapters with intent, file summaries, risk labels, and changed-line counts.
- The chapters list, **Chapters | All files**, starts with the Overview, which says where the review stands, then a bar of viewed files with **Next unviewed**, then each chapter, with its files named by the shortest end of their path no other file shares, and the current file kept in view. **Skip to code** comes first for the keyboard. On a phone the switch heads the chapters sheet, and the files viewed share the bar's row.
- Each chapter opens on an intro: one line ("Chapter 1 of 3 · Medium risk · 3 files · 27 lines · 0 of 3 viewed"), its title, and its overview. Medium- and high-risk chapters add **What to verify**, one to three things to check, ending with **Dig deeper**, which asks the review agent for a closer pass over that chapter at high effort, with at most 5 comments, arriving in Comments. On a phone the overview shows three lines until **More**, and **What to verify · 2 ›** is one line that opens the list.
- Every changed file appears in one chapter, except that a guide can split a file mixing unrelated changes: each chapter then shows only its hunks, with an "Also in" note. Files the guide leaves unplaced appear in a last **Other files** chapter.
- A chapter ends with what you've viewed and commented, **Mark viewed and continue**, and **Next: …**; the last one offers **Mark viewed and finish** or **Finish review**, and names the files you haven't viewed yet.
- **Mark chapter viewed** works on any chapter: on the open chapter's card in the chapters list, from the ✓ another chapter shows on hover or focus with a mouse, with `⇧V`, or at the chapter's end. It, **Mark viewed and continue**, and **Mark viewed and finish** leave a file split across chapters for the last chapter holding its hunks, and the toast says where it continues ("a.ts continues in Caching."); the file's own **Viewed** still marks all of it. **Undo** in its toast puts every file back as it was. A mark that didn't save is put back, and says so.

### The diff

Syntax-highlighted diffs and viewed-file tracking.

- Changed lines are marked + and −, not by color alone, with a bar beside them, dashed for deletions.
- A new file shows as a file, its code with a rail beside it, under **New file** and its length; a deleted file starts folded ("Deleted · 65 lines"); **Show as diff**, or Diff options' **New and deleted files**, shows them as diffs, in every review.
- A Markdown file (`.md`, `.markdown`) switches between **Source** and **Rendered** in its row, or with `m`; Diff options' **Markdown files** picks which it opens as, in every review. Rendered draws it through BB's Markdown a block at a time, a list's top-level items each on their own, with a bar beside each added (green) or changed (amber) block, each removed block dimmed with a dashed red bar where it was, and **Show previous** in a changed block's gutter, on hover or keyboard focus, and always on a touch screen; long runs of unchanged blocks fold. A changed paragraph, heading, list item or quote marks its words as GitHub does, deleted ones struck and inserted ones underlined, a link's words too, unless the change crosses Markdown's syntax or changes a link's URL, which "Link changed" says under the block for inline and reference links; on a BB whose Markdown doesn't draw the marks, changed blocks show whole. A changed table tints its new and changed rows. A PR's relative links go to their files at its head on GitHub. The file's own HTML links stay links, as on GitHub, opening in a new tab: only to web pages and email addresses, keeping nothing of the tag but where it goes, and in a local review not the relative ones, which show as words; its HTML images show as links to them, or as their words inside a link. Comments, threads and CI failures show after the block holding their line. A block the diff shows takes a comment from the button left of its bar, on its lines in the diff, and a table from one beside each row; selected text picks the lines it covers (a table's rows, a code block's lines, the lines of prose it's on, or, where the words around an end read more than once, as a link's can, the whole block's) for **Comment** or **Ask agent**, or, outside the diff, **Ask agent** alone. Rendered is off, saying why, on a re-review's Since your review, for a file split across chapters, or when the file can't load.
- Unified diffs show old and new line numbers in their own columns, unchanged stretches name the function after them and expand 20 lines a click, 40 or more deleted lines in a row fold after their first three ("Show 174 more deleted lines", opening where a comment or your selection is in them), and lines new since your review are marked beside their numbers.
- Only a slim row sticks above each file's code: its path, "New since your review" or "Changed since your review" on a re-review, its comment count (drafts and unresolved GitHub threads), its additions and deletions, and **Viewed**.
- Under it, a row that scrolls away holds:
  - the guide's one-line summary, Renamed, Also in, and the file's owners;
  - "Changed since you viewed it" on a viewed file that changed again;
  - a chip on a test file whose diff removes assertions or skips tests ("3 assertions removed · 1 test skipped");
  - a lockfile's packages added and removed ("+3 −1 packages"), and a warning when one downloads from a host other than its registry;
  - a warning when the file's path or added lines hold hidden bidirectional Unicode, which can make code read differently than it runs;
  - what a file with no changed lines does ("Binary file.", "Made executable.", "New empty file.", or "GitHub didn't send this file's diff; read it on GitHub.");
  - **Show diff**, **Expand**, **Whole file**, and on a local review that ends at the checkout **Open in editor**.
- Lockfiles, generated and vendored files (`vendor/`, `third_party/`, `Pods/`, protoc and Dart generated files, and what `.gitattributes` at the PR's base marks `linguist-generated` or `linguist-vendored`), and diffs over 1,500 changed lines start folded, with **Show diff** ("Large diff · 1,600 lines"), and a file folds when you mark it viewed. Marked from its row while you're partway through it, it folds to that row at the top of the view, with the next file under it. A file the PR adds, or moves in from a path that isn't generated, is read as code whatever its path; Settings → Reading can turn off either fold, though huge diffs still start folded.
- **Expand** loads the whole file, to expand around its hunks; **Whole file** shows every line. Comments still go only on lines in the diff.
- A file whose diff can't be drawn says "Couldn't show this file's diff." in its card, with **Try again** and, on a PR, **Open on GitHub**; the rest of the review still shows.

### Diff options

**Diff options** (the sliders icon, at the band's end) holds how the code draws:

- **Layout**, Unified or Split (saved for every review; the diff goes unified when its pane is narrower than 960px, and says Split needs a wider pane).
- **New and deleted files**, As file or As diff (saved for every review).
- **Wrap long lines**.
- **Hide whitespace changes**, which shows whitespace-only changes as unchanged, like `git diff -w`.
- **GitHub threads in code** (remembered in this browser).
- **Collapse all** and **Expand all** for the chapter's files.
- With a mouse or trackpad, **Keyboard shortcuts**.

Where the band has no room for them, it also holds **Fold comments in code** and the comparison (see [Since your review](#since-your-review)). On a phone, and on one held sideways, it opens as a drawer from the bottom, without Layout: the diff is unified there.

### Code owners, All files, and Find

- CODEOWNERS owners on each file ("Owned by …"), read from the PR's base branch as GitHub does. Files you or your teams own are marked **yours**, and the review agent is told which they are. **Code owners** in Settings → Reading hides them; the agent still knows.
- **All files** switches the chapters list to every changed file as a folder tree, with a filter; each file shows whether it's viewed, its comments and discussions, whether it changed since your review, its kind, and its owners.
- **Find in review** searches every line of the diff, both sides, and the guide's text; a result opens its line in its chapter.

### Comments, threads, and CI in the code

- Comments show in the code, under their lines, as on GitHub, each with all its actions, so a whole re-review can happen in the code. See [Comments and Finish review](#comments-and-finish-review).
- Everyone's GitHub review threads show under their lines, with **Reply** and **Resolve**. Resolved and outdated threads are folded; outdated threads and file comments wait in their file's fold, "Outdated (1) · File comments (1)". **GitHub threads in code** in Diff options hides them all.
- CI failures with annotations show on their lines too, including ones CI reports after you open the review, with **View check**, unless **CI failures in the code** is off in Settings → Reading; the Overview lists failing checks either way. A failure's note also offers **Comment**, which opens a Blocking comment at the line quoting the failure, and **Ask agent**, which quotes it into the agent's box, unsent.
- **Fold comments** (`i`, or the band's button) shrinks every comment in the code to a one-line marker, with **Show** to open one, so the code reads on its own. On a phone they start folded. On a phone, and in a review under 440px wide, a marker takes two lines, its state on the first and its severity and first line on the second; one with **Not on GitHub yet** does so under 600px wide, as beside BB's side panel in a 1440px window.

### The review agent

**Ask agent** (`a`) opens the review agent in BB's side panel, its **Review agent** tab, beside the review; the button, pressed while the tab shows, closes the panel. The tab shows the review you're on, and switches when you switch reviews. In full screen, Ask agent leaves it, as BB's panel is outside it; on a phone, BB's panel covers the page, and its ✕ brings the review back. A BB app from before its side panel, before 0.48, opens the agent's chat as a thread beside the review instead, once one has started; to start one there, update the BB app.

- The conversation is BB's own chat: streamed answers, stop, queued messages, approvals, attachments, and a per-message model and effort picker.
- The agent can add, edit, and delete draft comments and write the summary, and the changes appear in Comments and the code as it works. When you ask, it posts for you too: see [Posting when you ask](#posting-when-you-ask).
- Besides the diff, it reads the PR's description, linked issues, commits, failing CI, other reviewers' open threads, and the repository's AGENTS.md, CLAUDE.md, Copilot instructions, and REVIEW.md, from the PR's base, and treats all of it as untrusted.
- Its tab's heading names the review, "Review agent · api#4512 · Fix login race". A chat deleted while it shows says "This review’s agent chat was deleted." with **Start a new chat**.
- A first message you haven't sent stays while BB's panel closes, or you go to another review and back. Once the conversation has started, BB keeps an unsent reply in its chat itself, as it does for each thread, the main thread's included, whose own page shows it too.
- Each review's agent conversation is a hidden BB thread, shown in the review with BB's chat. Review context (guide intent, chapters, and your Assistant instructions) reaches it as hidden instructions, refreshed when an idle conversation continues after the guide is updated or rebuilt, or the instructions change.
- Selections and the Ask agent button quote the file or lines into your message. With no file in view, Ask agent just opens the chat, its box focused.
- **New conversation** archives the current one; if a conversation's thread is archived or deleted, the next question starts a new one.
- Archived PRs can still be discussed: their conversations stay unarchived because BB cannot send to an archived thread.

### Posting when you ask

With **Let the review agent act when you ask** on, the review agent submits your review, replies on and resolves threads, comments on the PR, and changes its title, description, labels, reviewers and assignees, or closes, reopens or merges it, when you ask (`submit_review`, `post_reply`, `resolve_thread`, `github_pr`). On a local review whose branch is on GitHub it opens the PR (`open_pr`).

- What posts under your name (a review, a reply, a PR comment, a title or description, a merge or a close, a new PR) shows first in a form in place of the agent's message box, led by what it does: "Approve `flosports/web#4512` as @you", "Merge …", "Post to …", then exactly the text that posts, as written (a merge, the commit title and description that land, as the repo's settings make them, or that the repo's default applies), with one button naming it (**Approve**, **Request changes**, **Merge**, **Close**, **Open PR**, or **Post**) and **Don't post**. One click does it; **Don't post** closes it.
- A short **yes** you type in the review instead ("yes", "go ahead", "approve it") posts exactly what it showed, once, and closes the form; "ok, but…" or "close it" to a Merge form doesn't. "Just post it" in your own message skips the form, for one post, in a turn the plugin started too; an approve, request changes, merge or close only when your whole message is that short command ("just merge it", "approve it, just post it"); anything more goes through the form. Text that changed since it was shown is shown again.
- Labels, reviewers, assignees, resolving, reopening and ready-or-draft happen when you ask, without a form. Asked from another thread on someone else's PR, they go back to that thread first, as a post does; asked while the agent is on a turn it didn't start from you, such as the automatic review, they show in the form first, and the agent changes none of your comments.
- New commits since you reviewed, a changed base and similar warnings come back to you first, in a line; the agent posts past one only if you say so, and the form shows it. A merge happens only at the commit you reviewed: with commits since, Update the review first.
- A risky ask gets one pushback and a better route, then happens your way: a merge while checks run offers to merge once they pass; a force-push, to send it to the main thread instead; merging a teammate's PR, or changing its labels, title or description, to suggest it in a comment. Where your GitHub role doesn't allow something, it says so and offers a reply instead.
- Whose ask it is decides what happens: see [Who's asking](#whos-asking-and-the-approval-rule).
- Every post goes through the server's paced line of writes to GitHub and onto **Agent activity** in Finish review: "Posted reply on src/a.ts:12 · 2m ago", with a link, and the thread a relayed ask came from.

### Who's asking, and the approval rule

**What you type in a review counts as yours. Asks relayed from your other threads count too, for replies, comments, Comment and Request changes reviews, and your PR's title, description, labels, reviewers and assignees. Approve, merge and close need your own message or click in that review.**

Each of the review agent's turns is yours, relayed, or no one's:

- **Yours:** what you type to the review agent, and what a click of yours writes to it, such as Ask agent on a line, Dig deeper, **Check fixes**, **Check now** or **Open PR**. The agent posts after the Post form, or your yes, as above.
- **Relayed:** a message from another of your BB threads, with `bb thread tell <agentThreadId>`, `bb review ask` or `bb review approve`. A reply, a comment, a Comment or Request changes review, or your PR's title or description goes back to that thread first, exactly as it would post, with no form; that thread's short yes, your own yes in the review, or "just post it" in the ask posts it. An approve, merge or close waits in Needs review as [Ready to approve](#asks-and-approvals-from-other-threads) for your click.
- **No one's:** turns the plugin starts on its own (the automatic review, new-commit checks, and the fix and feedback checks it runs itself; a click on **Run review** counts as one), turns bb starts on its own, such as a child thread's outcome arriving, a message from one of the review's own agents or a thread they started, an agent's message that names no thread, and any turn the plugin can't place. They only draft: the agent's verdict is marked as its suggestion, never picked for you, and nothing is posted, sent, or changed in your comments. A message you type into one while it runs is yours, but a change without text it asks for, such as a label, shows in the form first.
- Only your own words count: in a message the plugin writes on your click, such as Dig deeper's, the PR's words (a chapter's title, a file's path) never count as your "yes" or "just post it". A message that carries any text the plugin put in it, such as a quoted selection, file or failing check in the agent's box or a comment box it filled, confirms nothing: use the Post form, or say yes in a message of your own.
- How it tells: the plugin marks each message it sends the agent with a part only the agent sees, and reads bb's own record of who started each turn and which thread relayed a message. A thread's id comes from whoever sends the message, so this tells your threads from your typing, not you from someone else with a shell on your machine (see [What the agents can and can't do](#what-the-agents-can-and-cant-do)).

### Guides that stop or fail

- A guide writer that stops without a guide the plugin accepts is reminded once; a guide that still fails says why under **What went wrong**, and the plugin log keeps it.
- **Stop**, on the building screen or a guide update's notice, stops the guide writer: an update goes back to the guide you had ("Stopped. The guide is as it was."), and a first guide says "Guide stopped", in its status line too, with **Build the guide**, on a merged or closed PR too.
- A guide a reload interrupted restarts once its writer's machine reconnects, for up to 10 minutes; meanwhile its page and its status line say "Waiting for the guide writer's machine", and its update notice says "The guide writer's machine is offline. The update restarts on its own when it reconnects.", the page and the notice with **Try again**. After that it reads as failed, and says why under What went wrong, as does one whose restart failed, as when GitHub couldn't be read.

### Notices and Review actions

- One notice strip under the band says what to know: "New commits since this guide was written." with **Update guide** (or, when a stacked PR is retargeted, "The PR's base changed from parent to main since this guide was written."), "The code changed." on a local review, with **Update** and **Rewrite guide**, a folder's changes, branch, machine and other threads on a folder's review, a guide update that failed and why, or one waiting for its writer's machine to reconnect, what didn't run on its own and why, a GitHub account that GitHub refuses for the repository (not when GitHub just can't be reached), or "Reconnecting…" while the connection to BB is down; the review reloads once it's back. While a guide updates, its notice offers **Stop**, which keeps the guide you had. **+N** shows the rest.
- **Review actions** (⋯) lists, in the same order everywhere: **Update guide** or **Rebuild guide** (on a PR), **Snooze**, **Pin**, **Rename…**, **Rewrite guide** (on a local review), **Archive**, **Open on GitHub**, **Keyboard shortcuts** (not on a phone), **Review settings…**, and **Delete…**.

### When the PR changes

A review is pinned to the PR snapshot it was generated from. If the PR gets new commits, or a new base, as when a stacked PR is retargeted after its parent merges, choose **Update guide** before submitting. Submit warns first, keeping your draft: **Submit anyway** posts on the commit you reviewed, and an approval says how many commits it covers that you haven't seen.

- Unsent draft comments follow their lines into the new diff, with their discussions with the agent: a comment follows its exact code, indentation included, to the nearest line holding it, and re-indented code only when the exact code is gone.
- A comment whose line is gone, or on code as common as `}` whose neighbouring lines changed, is marked **Older diff**: edit and save it, remove it, or **Move to summary**, which adds it to your summary as a line ("On `src/api.ts:57` (an earlier diff): …") and removes the comment, with no Undo, before submitting.
- Submission failures retain the draft; repeated clicks cannot submit the same draft concurrently.
- Unsaved summaries and comments keep a recovery copy in this browser tab, bound to their original review revision.
- While the guide updates, the current one stays, with your unsaved edits.

## Keyboard shortcuts

| Key | Action |
|---|---|
| j / k | Next or previous file; on the Overview, `j` starts the first chapter |
| ⇧J / ⇧K | Next or previous change in the chapter's code; past the last, the next file |
| n / p | Next or previous chapter |
| u | Next unviewed file, in any chapter |
| ] / [ | Next or previous comment or discussion, in Comments' order and filter |
| / | Find in review |
| f | All files, with the cursor in their filter |
| v | Mark the file viewed, or not, and go to the next |
| ⇧V | Mark the chapter viewed |
| t | Show or hide the chapters |
| c | Show or hide Comments |
| a | Ask agent |
| s | Finish review |
| Esc | Close what's over the code, leave full screen, or clear the lines selected |
| d | Since your review or All changes, on a re-review |
| i | Fold or unfold comments in the code |
| m | Rendered or source, for a Markdown file |
| ⇧F | Full screen on or off |
| ? | Show these shortcuts |

They work anywhere in a review, its commands in BB's title bar and the chapters or a panel open over the code included, except while you type, or with Ctrl, Meta, or Alt held; `]` and `[` also work where AltGr or Option types them. With Caps Lock on, a letter acts as its lower case: Caps Lock V marks the file, and only Shift gives `⇧V`, `⇧F`, `⇧J`, and `⇧K`. Holding a key repeats only `j`, `k`, `⇧J`, and `⇧K`. `j`, `k`, `v`, `]`, and `[` move the focus to the file or comment they go to; a screen reader hears each command's key.

With **Comment keys** on (under Single-key shortcuts in Settings → Reading), these act on the comment `]` or `[` last landed on, or a row you chose in Comments:

| Key | Action |
|---|---|
| e | Edit it |
| x | Remove it, yours or the agent's, with Undo, except on an older diff |
| 1 / 2 / 3 / 4 | Blocking, Should fix, Question, or Nit, with a toast; a Pre-existing mark stays |
| 0 | Clear its severity |
| r | Reply to the GitHub thread |

A comment on an older diff keeps its severity until you edit it. In a comment box, Cmd/Ctrl+Enter saves and Esc leaves the box with your text in it; the shortcuts sheet lists both.

If you use speech input or press keys by accident, turn off **Single-key shortcuts** in Settings → Reading. Every key above goes, with the hints that name them, and `/` and `f` on All reviews too; Esc still closes what's over the code.

### Command palette

With **Commands in BB's command palette** on (Settings → Reading), BB's palette lists:

- **Code Review Workspace: Next review that needs me**, with ⌘⇧U (Ctrl+Shift+U) as its default key unless BB already uses it.
- **Code Review Workspace: Review PR from clipboard**, which opens the review of the PR link you copied, or starts one and names it ("Started a review of acme/web#7: Fix cache keys") with **Open**.
- **Code Review Workspace: All reviews**.
- **Code Review Workspace: Switch between review and main thread**, with ⌘⇧. (Ctrl+Shift+.) as its default key: on a thread's page it goes to the thread's review, the one its Review tab shows, and on a review's page to its main thread. It's listed only where there's one to go to.

Give them keys of your own where BB lets you. The commands need a BB that supports app overlays, as the thread list's Needs review does (see [BB's thread list](#bbs-thread-list)); without them, the palette doesn't list them.

## Phone and iPad

- Every control is a 44px target on a touch screen, iPads included. The gutter's **+** shows only with a mouse or trackpad; on touch, tap a line, then another for a range.
- On an iPad, the layout is the desktop's at touch sizes, and a docked panel that no longer fits after a resize hides, and docks again when there's room.
- On a phone there's no band: a dock at the bottom holds **‹** (All reviews), the chapter you're on, **Comments**, **Ask agent**, **Main thread** while the review has one, and **Full screen**. The chapters and Comments open one sheet above it; **Ask agent** opens BB's side panel over the page, whose tabs include **Main thread**; **Main thread** goes to the main thread. Menus open as drawers from the bottom.

Every layout detail, held either way and on foldables such as the iPhone Duo, is in [docs/devices.md](devices.md).

## Whose turn

### All reviews

**All reviews** has four sections, in the order you'll work them. Needs review starts open and the others closed; each remembers what you chose, in this browser.

- **Needs review**: it's your turn. Approvals, merges and closes your other threads asked for (**Ready to approve**, see [Asks and approvals from other threads](#asks-and-approvals-from-other-threads)), reviews that came back to you (**Back to you**), new reviews and requests for your review (**New**), and **Team requests**, each longest-waiting first. **Blocks merge** marks a changes-requested review that's the only thing left, since everyone else approved; it comes first. Your own PR comes back to you as **Your PR · 3 new comments in 2 threads** when someone's comment waits for your reply, with an alert; a bot's comment never brings it back. One you started a review of shows here as **Your PR** until you've reviewed it; otherwise your PRs wait in Reviewed, never on an author.
- **Waiting on author**: you requested changes, or commented with threads still open, and the author hasn't said they're done. Rows show progress (`2/5 addressed`, `+1 nit`), new commits, CI, outdated threads, and how long the author has been quiet. Snoozed reviews wait here too.
- **Reviewed**: you approved, or commented with every thread resolved or answered. A push after your approval adds “updated” but doesn't bring it back. Your own PRs with nothing waiting for your reply wait here too.
- **Archive**: merged, closed, or archived by you; a PR found on GitHub that no longer requests you (**No longer requested**); and one GitHub hasn't found for 7 days (**Can't read on GitHub**).

Rows and the box:

- Each row is two lines: the title (your name for it, once you've [renamed](#rename) it, with the PR's title on hover), repository and number, and age (in Needs review, how long it's been your turn), then why it's yours and only the facts that change whether to open it, such as the PR's size (`+120 −30 · 8 files`, its added lines green and removed red).
- A row starts with its author's GitHub avatar, their initials while it loads or where it can't, and `@author` on hover; a local change shows a branch.
- A PR's GitHub labels end its second line, under its age, each with a dot of its GitHub color: three at most, then `+2` naming the rest on hover. They hide where the list is narrow.
- With a mouse, hovering a row shows **Snooze**, **Pin**, and **Archive**; on touch, every row has its **Review actions** (⋯).
- The box at the top finds a review, filtering the list by repository, @author, title (yours or the PR's), or #number, or takes a pasted PR link or `owner/repo#n`: **Open** the review if it's listed, or **Review** it to start one. `/` puts the cursor in the box; on a phone, ⌕ in BB's title bar opens it. The list keeps the box's filter when you come back from a review.
- **Filter** (or `f`) under the box narrows the list by **Status**, **Author**, **Reviewers**, **GitHub team reviewers**, **GitHub labels**, **Repository owner** and **name**, **Kind** (pull request or local), **Checks**, **Your verdict**, or when a review was **added** or its PR **updated**, **merged** or **closed**. Pick a field, then tick its values, each counted; a date takes a span, in the last 3 days or more than a week ago. Each filter shows as a chip: click how it matches to flip it (is / is not), its values to change them, or ✕ to remove it. A review must match every filter, and the box's words too; the sections open to show them, and one you close stays closed until the filters change. The list keeps its filters when you come back from a review, as it keeps the box's words, until you close the tab. A value list taller than the menu scrolls, its last row cut in half; hover a long value for all of it.
- **Save view** keeps the filters under a name, such as "Live 4 Project" or "Updated this week", in the plugin's database, so they're the same in every browser and on a phone, and other open windows update. Your views show above the filters as tabs after **All**, which clears them; pick one to set its filters. A date span stays relative, so "in the last week" is always the last 7 days. Change a view's filters and **Save** updates it or **Save as new** names another; **Edit view**, at the end of the filters while you're in a view, renames or deletes it; a deleted view's filters stay set, so **Save view** brings it back. Views keep filters only, not the box's words.
- **Reviewers** are everyone asked to review or who has, if only to comment, but you and bots. **GitHub team reviewers** are the teams asked, still listed once a member reviews for one. **Closed** is closed without merging. Labels, team reviewers, reviewers, and GitHub's dates fill in as the sync next reads each PR, a merged one included.
- **Refresh** and **Settings** sit in BB's title bar. Refresh's tooltip says when GitHub was last read, and the list says why it can't be read now: GitHub CLI not on the BB server, `gh` not signed in, a rate limit (reading then pauses for 15 minutes), or PRs or teams it can't see.
- Stacked PRs sit together, bottom first, labeled `Stack · 2 of 3`; a review's Overview links **Stacked on #N** and **#N builds on this**, and says when you haven't reviewed the PR below.

### BB's thread list

BB's thread list shows **Needs review** too, below Pinned and Threads: the same reviews in the same order, with how long each has waited. It collapses like the other groups, and choosing a review opens it.

- **Pin** a review, from its row there (with a mouse) or its **Review actions** menu, to put it in BB's Pinned group after your pinned threads; it stays until you unpin it or it moves to Archive, and the list marks it with a pin.
- BB has no plugin slot for any of this, so Code Review Workspace adds it to BB's list itself, through BB's app overlays. A BB without app overlays shows neither this group nor the palette commands. If a BB update changes that list, it may not show until Code Review Workspace catches up.
- To keep BB's list to threads, turn off **Show reviews in the thread list** in Settings; your pins are kept.

### What brings a review back

A push alone never makes a review your turn: authors often push one fix at a time. A review comes back to **Needs review** when:

- the author **re-requests** your review (it even leaves your archive); a request to a team you're on isn't a re-request;
- the author **asks you something** on one of your threads, or anyone mentions you on the PR, in a review, or in a line comment and you haven't commented since, whatever your verdict. **Whose turn → When the author replies** chooses which replies count: **Questions for you** (the default) or **Any reply**, to come back on every reply. Turn off **Come back when you're mentioned** to leave mentions out. Only the author's replies count on your threads; anyone else's counts when it @mentions you;
- every thread you opened is **resolved or answered**, apart from non-blocking ones, there are new commits, CI isn't running or failing, and the author has been quiet for 10 minutes;
- with **After the author pushes** set to **Check, and bring it back when everything's addressed**, the review agent finds all your feedback addressed;
- GitHub dismisses your review.

**After the author pushes** is one of three choices, and needs **Run the re-review check** on:

- **Do nothing** (the default): pushes alone don't start a check.
- **Check my feedback**: while the review waits on the author, the review agent checks your feedback after their pushes and shows its progress, without bringing the review back.
- **Check, and bring it back when everything's addressed**: the same check, and the review comes back once it finds everything addressed.

Either check runs once the author's pushes have been quiet for 15 minutes and CI has settled.

Once a review comes back because your feedback was handled, it stays in Needs review until you act, even if the author pushes again. Your verdict is your latest approve or changes-requested review, as GitHub counts it: replying to a thread doesn't change it.

Code Review Workspace alerts only about what happens after it starts following a PR: after an upgrade, or when it first finds PRs on GitHub, the list fills in quietly, except new requests for your review.

### Snooze

- If a review came back too early, choose **Snooze → Until the author responds** in its **Review actions** menu, its row, or its Overview. It waits on the author until a newer reason; pushes alone don't wake it.
- Snooze's other choices, **Later today**, **Tomorrow**, **Monday** (**Next Monday** on a Monday), and **Pick a date…**, set aside a review or a new request until then (between midnight and 9 AM, Pick a date can choose this morning). It waits as "Snoozed until Mon 9:00 AM" and comes back at that time, with a Needs You alert, or sooner for a newer reason, which alerts then and not again at the snooze's time.
- **Back to Needs review** ends a snooze.
- Snooze, Pin, Rename, and Archive can be undone from their toast.

### Which review you're in

- Every review goes by a short id: the repository's name and the PR's number, `api#4512`, or for local work the repository and branch, `api:feat/snooze-checks` (a bb branch reads as its slug: `bb/snooze-checks-thr_…` is `snooze-checks`). Where two repositories in your list share a name, the id names the owner, `flosports/api#4512`; where two local reviews of one branch are in different folders, it adds the end of the folder's path that tells them apart, `api:HEAD (thr_a-1/api)` for bb's worktrees; and where they're in one folder, as `main...feat` and `feat`, it says each ref as given.
- BB's title bar, after the panel's name, and the window's title lead with it, then the review's name: `api#4512 › Fix login race` in the bar, `api#4512 · Fix login race` as the window's title. Each pane's bar names its own review, so two reviews in split panes, or two windows, read apart, and a long name is cut before the id is. In a window under 720px the bar shows them as one title, cut at its end.
- A folder's review goes by its main thread's title, frozen when the review starts, then by its PR's once it has one. A local ref's review with no name of yours goes by its guide's title. Either goes by your name once you [rename](#rename) it.
- The band keeps the id in a chip after ‹ on every page of the review. The name follows it in a chapter only where BB's title bar doesn't show it, in full screen or on a BB without page titles, and where the band has room. Short of room, the repository's name is cut first, and `#4512` never; hovering the chip shows the whole id, with the repository in full, and the name. On a phone, the dock's chapter tab has the id over the chapter, a long one cut from its end ("web:feat/snooz…").
- The page bar of a review without a guide yet, the review agent's and the main thread's tabs, a PR's row in BB's thread list (its `#n`), Needs You alerts, review agent and **Fix in a new thread** threads, and what Send sends all name the review by its id. A local review's row in All reviews says its id and machine, `api:feat/x · MaxBook`, and its Overview the machine and folder of its checkout.

### Rename

- **Rename…** in a review's **Review actions** menu (⋯), the pencil beside the Overview's title, or `bb review <target> --name "…"` gives it a name of your own. All reviews, BB's thread list, the review's band and title, Needs You alerts, and the title of a **Fix in a new thread** thread use it in place of the PR's title.
- The pencil shows on hover or focus with a mouse, and always on a touch screen. It turns the title into a box: Enter, or leaving the box, saves the name, and Esc leaves it as it was. A review's own agent can't rename it. It stays in BB: the PR keeps its title on GitHub, and the agents read that one.
- The PR's title is under your name on the review's Overview, shows when you hover its row in All reviews or BB's thread list, and is in the Rename dialog with **Use PR title**. The find box matches either.
- Your name stays when the author retitles the PR or pushes, and when the guide is rebuilt. **Use PR title**, or an empty name, puts the PR's title back, and Delete forgets it. A local review's name stands in for its ref the same way, with **Use ref**.

### Non-blocking threads

A thread whose first comment starts with `nit:`, `FYI:`, `optional:`, or `non-blocking:` (bold or not) is **non-blocking**. It doesn't keep a review on the author, progress counts it apart (`2/2 handled +1 nit`), and Request what's left leaves it out; a question on it still brings the review back. Comments you submit with the **Nit** severity start that way, pre-existing ones too.

### When a review comes back

**When a review comes back, it's prepared for you.**

- An out-of-date guide is rebuilt for the new commits, keeping its chapters where the files still fit and summarizing what changed since your review; if the rebuild fails, the previous guide stays. (For a PR found on GitHub, without a guide of its own, this happens only in your auto-start repositories.)
- Then the review agent checks your feedback, in the review's own conversation: for each of your threads, and each ask in your review summary, it records whether the author **addressed** it, partly, not at all, or disagreed, with one line of evidence.
- It also looks for new problems in the fix commits, drafts replies to your threads, and suggests a verdict with a summary, which goes into your draft.

Comments shows all of it:

- The agent's check sits at the top ("Agent’s check · a1b2c3d · 2h · 2 of 3 addressed", with **Check again**).
- **Needs you** lists each thread that needs you, non-blocking ones last: your comment, the author's replies, the agent's verdict and evidence (**Show the fix** opens its line), the drafted reply waiting as an "Agent reply draft · not sent", **Reply**, **Resolve**, and in ⋯ **Follow up** (a new draft comment at the line).
- Your feedback's progress on the Overview opens it.
- If you'd already written your own summary, the suggestion waits in **Finish review**: **Use as draft** puts it and its verdict in your draft. **Request what's left** drafts a Request changes listing what's still open.

Nothing posts to GitHub until you choose Send reply, Resolve, or Submit, or ask the review agent to post and confirm it. **Get a review ready before alerting you**, on by default, holds the alert for this, at most 10 minutes; off, the alert comes at once, and **Update guide** and **Check again** are a click away. Change the check's instructions with **Re-review check** in settings, or turn it off with **Run the re-review check**, which keeps them.

### Since your review

On a re-review, the diff opens on what changed since your review, however you get to a chapter: Review changes, Continue, a chapter you pick, or a comment. To open on the whole PR instead, choose **All changes** under **Settings → Re-reviews**.

- A switch in each chapter's intro flips between the two in one tap, on every device, and says how many of the chapter's files changed: "Since your review · 1 of 3 files | All changes". A chapter with nothing new says "Nothing changed in this chapter since your review".
- **Since your review** shows only what changed since the commit you last reviewed, with new lines marked. It compares the PR's diff then with its diff now, so rebases and merges from the base branch don't show up as changes, and a diff that didn't change, as after a rebase, opens on all of it. Viewed marks survive a rebase, and chapters show how many of their files changed.
- The compare select in the band says what the diff shows too: **All changes**, **Since your review**, or since a commit. Its menu lists your last review, then the PR's earlier commits: pick one to see what changed since it ("Since abc1234"). On a PR you haven't reviewed, **Compare with a commit…** in Diff options does the same. Once you've sent comments to the main thread, the menu also lists **Since your last Send**, with the Send's number and when it went: what changed since the diff that Send went at, on a local review too. A newer Send lets that choice go, as a new push does. Where the band has no room for the select, Diff options holds the comparison. A comparison that fails says why, and the diff shows all changes.
- What you choose holds for that review in this browser, a picked commit too, until the author pushes and its guide updates; then it opens on your Settings choice again. Opening a file or a line the comparison hides, from the chapters, a comment, or a Find result, shows all changes, and that holds too.

### Reviews found on GitHub

- With **Track reviews from GitHub** on (the default), PRs where your review is requested, and open PRs you've reviewed that changed in the last 60 days (unless **Include PRs you've reviewed** is off), join the list without a guide; build one with **Build the guide** on its page or in its menu.
- So do your own open PRs (unless **Include your own PRs** is off), with everyone's comments. Your PR of a branch you're reviewing locally doesn't join as another review: that local review becomes the PR's, or merges with the PR's review if it already has one. No agent starts on them on its own.
- Requests to a team you're on join only with **Include team requests** (off by default): teams can be asked for many reviews.
- Turning on either switch fills the list with what it finds already there, without starting guides or alerting.
- List patterns under **Start guides automatically** (`acme/*`, `acme/api`, or `*`, up to 50 lines) to have the guide ready by the time a request alerts you.
- A PR you delete isn't added back.
- Reading GitHub costs about 6 GraphQL points per 10 PRs a pass, plus about 2 points to re-read the threads of an active review with an open thread of yours, every 10 minutes, out of the 5,000 an hour your account has. How often each group is read is in [docs/operations.md](operations.md#how-often-github-is-read).

### Archive and delete

- Where a submitted review appears depends on whose turn it is (see [All reviews](#all-reviews)).
- Merged and closed PRs move to Archive automatically; their guides, conversations, and unsent drafts remain accessible.
- GitHub is checked every one to two minutes for reviews in progress, sooner when GitHub notifies you about a PR, and through Refresh. A failed GitHub read preserves saved state.
- To set aside any other review, choose **Archive** from its **Review actions** menu (⋯) in All reviews or the review's title bar. It stays in Archive, even when new commits arrive, until you choose **Unarchive**, start it again with `bb review`, update or rebuild its guide, or the author re-requests your review.
- **Delete** permanently removes the review's guide, drafts, private notes, and agent conversation, including its hidden worker threads and guide writers, after confirmation, and this browser forgets where you left it and its agent dock; nothing changes on GitHub. Delete is unavailable while a guide is generating or the agent is answering. A deleted PR isn't added back from GitHub until you start it again.

### Notifications

Alerts go to **Needs You**, a separate, optional plugin (id `inbox`), version 0.2.0-beta.3 or later. Enable **Needs You → Settings → Extension activity** to receive popups, desktop alerts, or optional Telegram pushes through your chosen channels. **Open Needs You settings**, under Settings → Notifications, links there.

- A finished guide appears in your Needs You inbox with an **Open review** action. Failed generation has its own recovery message.
- A review becoming your turn alerts too: re-requested, a request for your review, a question for you or a mention, your feedback handled, or a timed snooze ending. Each event alerts once.
- **Settings → Notifications** turns off either kind: **A guide is ready or failed**, or **A review becomes your turn**.
- When Code Review Workspace prepares the re-review first, the alert waits for it (at most 10 minutes, unless **Get a review ready before alerting you** is off) and says how much of your feedback was addressed, for example `@alice re-requested your review · 4/5 addressed · CI passing · 2 new commits`.
- Opening the review, submitting, or snoozing it clears the alert.
- Each review has one inbox item; hidden worker threads do not create extra alerts.
- Quiet hours apply, and a popup stays quiet while you are already viewing that guide.

Needs You is optional. If it is disabled, missing, or restarting, Code Review Workspace keeps the guide successful and retries the delivery; see [docs/operations.md](operations.md#needs-you-delivery).

## Comments and Finish review

### The Comments list

**Comments** (`c`, or **Comments** in BB's title bar) lists everything said about the change, beside the code, never instead of it: your draft comments and the agent's, everyone's GitHub threads, and your discussions with the agent.

- Its chips, **All**, **Needs you**, **Not submitted**, and **On GitHub**, show a count each and filter the list; on a touch screen they wrap to a second row where they don't fit. **Not submitted** counts what Submit posts: it lists comments not on GitHub yet, "Draft · goes with Send", without counting them, and says "2 aren't on GitHub yet. They go with Send, not Submit."
- Once you've sent a comment to the main thread, chips for where the fixes stand follow, on a local review too: **Open**, **Sent** (not reported yet), **Done** and **Declined** (as reported, or as the check found), **Resolved**, and **Dismissed**; then only chips that count any show, and they wrap. On your own PR, teammates' threads and reviews you sent are under Sent, Done and Declined too.
- The list is grouped in that order: **Needs you** (a question for you, an author's reply, a thread the agent's check says isn't addressed, an agent reply draft, a comment on an older diff, and a comment you sent that the thread declined or the check found not or partly addressed), **Not submitted · only in BB** (**Comments** on a local review) (counted by severity, "1 blocking · 2 nits"), on a PR **Sent to fix · won't post** (comments a Send took from your own change, and any you resolved or dismissed, "1 sent · 2 done · 1 resolved"), **On GitHub** (yours first, "Yours: 2 of 2 handled +1 nit", then other people's; resolved and outdated threads folded), and **Private · with the agent**, in reading order within each.
- Choosing a row shows its comment in the code, switching chapter and unfolding it if needed; its ⌄ opens the whole card in place, which is how file comments, outdated threads, and asks from your review summary read.
- ↻ reads GitHub again. ⋯ **Comment options** holds **Hide nits** (remembered in this browser, in the code too), **Remove nits**, **Show resolved threads**, **Add comment by line…**, and **Open PR on GitHub**.
- While you write a comment in the code, the list says where, with **Show in diff**.
- Comments on a local review stay in BB.

### Comment cards

Every comment is the same card in Comments and in the code, and says where it lives, in words as well as looks.

- Anything only in BB is dashed and says so: "Draft · not submitted", "Agent draft · not submitted" for one an agent wrote, until you edit it, and "Older diff · not submitted".
- A GitHub thread is solid, headed **On GitHub**, with who wrote each comment and when, who resolved it, and its state: "Waiting on author", "Author replied", "Question for you", "Resolved", "Outdated", or "File comment". On your own PR, a thread whose latest comment isn't yours or a bot's reads "Needs your reply to @sam", naming whose comment waits, with whose thread it is beside the comment, and is in Needs you; the Overview's "3 new comments" opens them; your reply, or a resolve, settles it. Others' review summaries and comments on the PR show the same way, "Requested changes" or "Comment on the PR" beside them; your next comment on the PR settles them (see [Feedback on your own PR](#feedback-on-your-own-pr)). Threads only bots wrote in fold with the resolved ones, as "2 from bots".
- A discussion with the agent is muted, with a lock: "Private · with the agent".
- An agent's draft can fold **How the agent checked** under its words: what it read or ran to confirm the problem, with file:line. That stays in BB; submitting never sends it.
- A comment you sent to the main thread says where its fix stands, one status a card: Sent, **Done** or **Declined** with the thread's note, "Looks done · not reported", **Resolved** or **Dismissed**, each with its icon. Under its words: which thread said so, "Reported by the main thread", another thread by its title, which opens it, "Reported from the command line", or "Found by the review agent's check", and the commit it named; then what the review agent's check found against that comment's Send, its badge and one line. A note's `code` shows as code, on the card, its folded pill and its row in the list; nothing else of Markdown does.
- A sent comment's card leads its actions with **Resolve** (fixed), then **Reopen**, to send it again, once the thread reported on it or the check found it not or partly addressed, then **Dismiss** (won't be fixed), until it's reported done. A resolved or dismissed one offers **Reopen**. Only your click does any of them: no agent, command or report resolves a comment. Right after Resolve or Dismiss, its status reads "Resolved · **Undo**" for about 10 seconds, or until you leave the card; Undo puts it back as sent, with its report, or open if it was edited since, and doesn't send it again. A resolved or dismissed comment never goes with a Send, and keeps its id and what was reported; reopened, it goes with the next Send. **Remove** and **Undo** put a sent comment back with its id and where it stood. Only an open comment offers **Mark as pre-existing**.
- Images in other people's comments and the agents' words show as links ("Image: alt"), HTML comments stay hidden as on GitHub, and HTML tags other than a few that only format show as text; in code it can't be sure is code, a `<` shows as `&lt;` (see [Untrusted text](#untrusted-text)).
- `]` and `[` step through the list's current chip, across chapters; with Comments closed, a hint says where you are ("2 of 5 · Not submitted"), and on touch, after you open a comment from the list, a step bar does.

### Writing a comment

- With a mouse, click **+** beside a line to write one there, or select lines and choose **Comment** in the selection bar; on an iPad or phone, tap a line to select it, tap another to make a range, then choose **Comment**. Several lines make a range comment ("Lines 10–15"), sent to GitHub as a multi-line comment.
- **Suggest change** in the comment box inserts a suggestion block with the new lines' current text, fenced with more backticks than the lines hold, and draft cards show it as the code it would put in place.
- Edit or remove a comment in place; Cmd/Ctrl+Enter saves, Esc leaves the box with your text in it, and **Cancel** discards it.
- If a comment lands on the line while you write, the box says "This line already has a comment. Saving yours replaces it." and its button reads **Replace comment**.
- An edit box whose comment changed while you edited it, in another window or by an agent, says so over its new words before you replace it; one whose comment a guide update moved follows it, and one whose comment was removed meanwhile says it was moved or removed, and that saving puts yours back.
- A box whose line is no longer in the diff, after a reload or a guide update, moves to Comments, where you can finish it or move it to another line; so does a box on a line Since your review hides, with **Show in diff**, which shows all changes and puts the box back under its line.
- A draft saved or removed in one window shows in the review's other windows.

### Severity, Undo, and pre-existing problems

- Each line comment can have a severity: **Blocking**, **Should fix**, **Question**, or **Nit**. Set it in the comment box, or start the comment with its label, such as `**Blocking:**`; the card shows it, and GitHub gets the label in front of the comment.
- Removing a comment shows a toast with **Undo**, which puts it back on the diff it was removed from; after a guide update, it says why it can't.
- Changes from the review agent or `bb review comment` appear in Comments and the code as they happen. Agents can also edit and delete comments, and change yours only when you ask, on the comment or, with **Let the review agent act when you ask** on, in chat. Nothing in the draft posts until you submit.
- With **Keep pre-existing problems apart** on, the agent marks a problem in code the PR didn't change, and its card says **Pre-existing**, beside the severity. **Mark as pre-existing** and **Mark as from this PR** in a draft's card change it. A pre-existing comment doesn't count as blocking against Approve, Not submitted counts it apart ("· 1 pre-existing"), and it posts with "**Pre-existing:**" in front, as it does when you move it to the summary or send it to a coding thread.

### Discussions with the agent

Discussions with the review agent sit under a line, kept apart from its comment.

- **Ask agent** on a comment opens a box under it: say what's wrong or ask why, and the agent answers there, or edits or removes the comment. **Undo** puts back its latest change.
- **Ask agent** in the comment box, or on selected lines, asks about the lines without adding a comment.
- Text selected in the code, a long-press included, offers **Ask agent about selection** (unless **Ask agent about selected text** is off in Settings).
- Discussions stay in BB: submitting sends only the comments, and clears the discussions.

### Replies and resolves

What you write in a reply, on anyone's GitHub thread, waits as a reply draft ("Reply draft · not sent") until **Send reply** posts it, at once, not with your review; **Discard** drops it. **Resolve** posts at once too, and says so. Both post as the GitHub account the review verified, and wait until it has. A reply or resolve in the code shows in the list at once, and the other way round.

### Finish review

**Finish review** (`s`, **Finish review** in BB's title bar, or the bar at Comments' foot, which says the verdict and how many comments will be sent, on a local review how many open comments Send would send; a phone's dock says "2 to send", counting comments not on GitHub yet too, which go with Send) holds what goes to GitHub when you submit: the summary, the verdict, and exactly what will be posted.

- **Summary · posted with your verdict:** the comment GitHub shows with your verdict, above the line comments. It works like a line comment. The review agent writes it, labeled "Agent summary · not submitted", and suggests a verdict; only you pick the verdict. **Edit** makes the summary yours, and **Remove** clears it. **Ask agent** opens a discussion with the agent under the summary: ask why, or say what to change, and the agent changes the summary there. **Undo** puts back its latest change. The agent never replaces a summary you wrote unless you ask on it, and then only while it answers that ask, not in work it was already doing. While it works on the summary, Edit waits; if the summary changes while you're editing it, the box says so before you save. When a summary the agent wrote no longer fits your comments, or the verdict you picked, it says so, with **Update**. With no summary, **Write summary** or **Ask agent to write it**. Since Move to summary can put an agent's words in it, the card shows any summary's images as links, yours too; GitHub gets it as written.
- **Verdict:** Approve, Comment, or Request changes, the agent's suggestion marked with a sparkle. "Agent suggests …" shows its suggested summary, or its check's, with **Use as draft**, **Request what's left**, and, when you picked another verdict, **Switch to** it. Beside it, Finish review says how many of the changed files the agent read as the change leaves them ("Read 6 of 8 files", lockfiles and generated files aside) and folds **What it didn't check**, as the agent wrote it (unless **Show what the agent checked** is off). On your own PR only Comment is offered, as GitHub refuses the others.
- **Goes to GitHub:** the comments and their severities, and anything to settle first, each with its fix: comments on an older diff (edit or remove them, or **Move to summary**; Submit warns, and **Submit anyway** moves them into the summary), a Request changes without a summary (it waits for one), a verdict other than the agent's, or an approval with blocking comments. While you approve, it also flags files in high-risk chapters you haven't viewed ("2 files in high-risk chapters not viewed", with **Show**), and each medium- or high-risk chapter of 50 lines or more marked viewed faster than anyone reads ("Chapter 2 (high risk): 1,200 lines marked viewed in 3 min", past 500 lines an hour); lockfiles and generated files don't count. **Check before you approve** in Settings turns these off, and sets the pace. When the agent suggests Approve but didn't read every changed file, a row says so ("The agent suggests Approve but read 6 of 8 files", with **Show**). Pre-existing comments are counted apart. Reply drafts are listed too: they post on their own, with Send reply.
- **Stays in BB:** **Private notes**, only if you have some (see [Upgrading from older versions](#upgrading-from-older-versions)).
- **Submit to GitHub**, with your verdict on it ("Submit to GitHub · Approve · 1 blocking"), pinned at the foot, with where it posts and as whom. It asks once more (**Submit anyway**) when the verdict isn't the one the agent suggested, the agent's summary is out of date, or you approve with blocking comments, high-risk files not viewed, chapters read faster than your set pace, or files the agent didn't read; otherwise it's one click. It reads **Submitting…** while it posts, and waits while you're writing a comment or the summary. Submit refuses a draft whose comments, summary, or verdict changed since the page last showed them, or a page that doesn't send them, and one with comments you sent to the main thread when it can't tell whether the PR is yours ("Couldn't tell whether this PR is yours, so nothing posted. Try again in a moment."), since that decides which of them post. Just before it posts, it checks again: a Resolve, Reopen or Send meanwhile gives "Draft changed · review it, then submit again.", and while a Send of the review's comments is going out, it says to submit again in a moment. If GitHub's answer is lost or doesn't come within 5 minutes, Submit looks on GitHub for the review it just posted and finishes with it, rather than post it twice; if it can't check, it says to look at the PR before submitting again. If you started a pending review on github.com, Submit says to submit or discard it there, with **Open it on GitHub**, then submit again. On your own PR, where GitHub takes only a Comment review, it offers **Submit as Comment**. Submit warns, with **Submit anyway**, on new commits or a new base since you reviewed, comments GitHub can't place (Submit anyway moves them into the summary), a closed or merged PR, or a guide still rebuilding; what GitHub refuses, such as Request changes without a summary, still stops it.

After you submit, the panel reads **Review submitted**: the verdict, where it posted and as whom, **View on GitHub**, **Add another review**, and the next review in Needs review, with **Open**. A merged or closed PR's Comments ends with "Merged · Archived" and **Open**: its **Archived review**, with the unsubmitted draft and notes to read.

### Send comments to the main thread

A review started with `bb review` in a thread has a main thread: the top thread working in the review's folder, or for a PR or ref, the thread you ran it in. It's the thread that writes the code, and gets the comments you send. Nothing goes to GitHub.

The loop, for a thread's work in its folder:

1. **Review changes** above the thread's message box, or `bb review` in the thread, starts the review ([A thread's folder](#a-threads-folder)).
2. Read it and comment; the review agent drafts comments too.
3. **Send** them, or **Send now** one: the main thread fixes each and reports it with `bb review report`.
4. Once it has reported them all, the review comes back **Ready to re-review**, with the review agent's check of each fix. **Resolve** what's fixed, **Reopen** what isn't, comment again, and Send again: reopened comments go with the next Send.
5. **Push** has the main thread commit what you reviewed and, once the review has checked that commit, push exactly it; **Push and open PR** then has the review agent draft the PR. The review becomes the PR's, and teammates' comments on it go round the same loop ([Feedback on your own PR](#feedback-on-your-own-pr)).


- **Send N to main thread** in Finish review sends the comments not sent yet, after whatever that thread is doing. Its picker takes the comments you keep, an optional message, sent before them, **Include the summary**, unchecked, which adds the review summary after them, and **Let it push when done**, the review's, off until you turn it on. Each comment goes with its id, file, lines and code; the message ends "Don't push until I say", unless you let it push, and says how to report on each comment. Under it, Finish review names the main thread and its machine, "Build snooze · MaxBook", with **Change main thread**: a local review and its main thread can share a title. On someone else's PR, **Let it push when done** asks once before it's on.
- **Send now** on a comment's card, in the code or in Comments, sends that comment alone; its hint names the thread and machine.
- Then Finish review says "Sent 2 comments to ‹thread›" with **Open**, or "Queued for ‹thread›: it's busy, and gets 2 comments when its turn ends", and each comment you sent says "Queued for ‹thread› · Send 2" until the thread takes it, then "Sent to ‹thread› · Send 2 · 2m", in place of its state: on your own change a comment is **Open** until a Send carries it, then Sent, then **Done** or **Declined** with the thread's note once it reports, and **Resolved** or **Dismissed** once you say. On your own PR, only open comments post with Submit: Finish review counts them, and says how many sent to fix won't post to GitHub. On a PR you don't own a Send changes nothing Submit posts: a sent comment stays "Draft · not submitted" too, and posts, unless you resolve or dismiss it. Edit it and it's open again, for the next Send; it keeps its id. Delete a queued Send from the thread's queue and its comments are open again.
- A Send while the review is being submitted doesn't go: "Submitting this review; try again in a moment."
- The thread reports on each comment with `bb review report <id> done|declined --note "…"`, from any thread, its subagents too, and runs `bb review ready` once it's finished. Another thread can run it too: the review then names that thread, or "the command line" for a shell outside any thread. The comment then says **Done** or **Declined**, with its note.
- Once it has reported every comment you sent, or ran `bb review ready`, the review comes back **Ready to re-review**, in Needs review, with an alert that names it, `api:snooze-checks · Build snooze`, and says who did what, "The main thread reported all 3 comments you sent. Checked: 2 look fixed, 1 doesn't". First the review agent checks each fix against the code since its Send, once per Send, with **Get a review ready before alerting you** and **Run the re-review check** on; for a comment the thread didn't report, it fills in what the thread's last reply and the changes show, as "Looks done · not reported". The notice under the band says "Checking the fixes…" meanwhile, then what came back and what the check found, with **Check fixes**, or **Check again**.
- A main thread goes idle whenever it hands work to subagents, so idle alone never means done: the review keeps waiting on it, under Waiting on author, and the notice says "1 of 6 reported. The main thread is idle but may still be waiting on subagents." with **Check now**, which has the review agent check the fixes so far.
- Archived or deleted first, it won't report the rest: the review comes back to Needs review, "Main thread archived · 2 of 3 reported", with no alert and no check, and the notice offers **Check now** and **Send the rest to a fresh thread**, which sends the comments it didn't report to a fresh thread, the main thread from then on.
- With no comments left to send, it offers **Send approval to ‹thread›**: an optional message and **Include the summary**, then "Approved", queued behind whatever that thread is doing.
- Some Sends ask first, with the choices to go on:
  - On someone else's PR: **Send anyway**. Your review on GitHub isn't changed.
  - A main thread that's archived: **Unarchive and send**, or **Start a fresh thread** in its folder.
  - A main thread that was deleted: **Start a fresh thread** in its folder, which becomes the main thread.
  - A folder BB removed: **Start a fresh thread** in a new worktree from the branch; its uncommitted work went with the folder. The review then reads that worktree, and still pushes to its branch.
  - Comments not sent yet, or an approval already sent for this diff, before **Send approval**: **Send anyway**. An approval never starts a thread: with the main thread or its folder gone, Send anyway only records it.
- **Main thread ↗**, in BB's title bar or the phone's dock, goes to the main thread: from reviewing to doing in one click, as the thread's **Review · 2 open ↗** comes back. **Show beside review**, beside it, shows the **Main thread** tab in BB's side panel instead: the main thread's chat beside the diff, with its own permissions, which thread it is, on which machine, and whether it's working now, so a Send waits for its turn. **Change thread** picks another thread working in the folder, or **Start a fresh thread here**, and Finish review's **Change main thread** opens the tab with that menu open; **Main thread ↗** goes to it. A review with no main thread has neither, nor the tab, and with Send to thread off there's no tab.
- **Send** and **Send now** say where the comments went, with **Watch**: the main thread beside the review, or on a phone, its page. Finish review's **Watch**, on a desktop or an iPad, shows the review agent's chat beside the review while it drafts the PR.
- Ask the review agent to fix a comment and it sends it with Send now, and says so. Say "you do it" and it writes the exact patch, which goes with that comment's Send for the main thread to apply as written: one thread writes the folder. A turn you didn't start sends nothing.
- **Push**, in Finish review on a local review of a branch in a GitHub repo (or a message of just "push" to the review agent in the review; "push anyway" for Push anyway), pushes exactly what you reviewed:
  - The main thread is told to commit the changes you reviewed and run `bb review report --commit <sha>`, and not to push. A folder with nothing to commit skips this: its head is the commit.
  - The review checks that commit: the folder is at it, and each file the branch commits is as you reviewed it, large and binary files the review hid too. A secret-looking file the review hid, as a `.env`, counts as changed, and so does one an earlier commit on the branch added, since the push takes the branch's history to GitHub.
  - It matches: the thread is told to push exactly it, `git push origin '<sha>:refs/heads/<branch>'`, never forced. After a fresh thread took over a removed folder, it still pushes to the review's branch.
  - It doesn't: "Not pushed. 3 files changed since you reviewed.", naming a file that may hold secrets, with the files, **Update first**, which shows the new code, and **Push anyway**, which pushes the commit shown only while the folder is still at it. A commit the check couldn't place, as one the folder isn't at, can't be pushed anyway.
  - GitHub has commits the folder doesn't: it says so before the thread is told anything, "Pull first, or Push anyway to try". A push without force may then be refused.
  - GitHub at the commit already: "Nothing to push".
  - When the main thread stops, the review reads the branch on GitHub: **Pushed**, or flagged when GitHub has another commit, with **Push again** and **Main thread ↗**. **Stop waiting** stops waiting for it.
  - Commits on GitHub that didn't come from Push, and no Send let the thread push, are news, not an alarm: "has new commits on GitHub that didn't come from Push", in Finish review and under the band, with **Update** and **Got it**. A teammate, CI or a thread may have pushed them. The review keeps the last head on GitHub you accepted. The first time a review reads GitHub's branch, it takes that as the starting point; a read that fails doesn't count, and neither does the thread's commit report, which, finding GitHub already at the commit it reports, flags it as pushed first. After that, it moves only when your Push lands on its checked commit, when a Send with Let it push covers the move, or when you say Got it. A Send with Let it push covers pushes from when it's sent until the first read after the review comes back Ready to re-review, then never again; its thread failing, or being archived or deleted, ends it at once. Any other move is flagged, however Push stands, even a thread pushing before it reports its commit. With Send to thread off, GitHub isn't read; a move made meanwhile is flagged once it's back on.
  - On your own PR with a fresh or forked thread working on it, or the folder it became a PR from, Push is in Finish review too. What you review is **Not pushed yet**: each time you open it, the review notes what it showed, and the commit is checked against that, at the PR's head. **Update first** opens it. That thread pushes `'<sha>:refs/heads/<branch>'` from its folder; for a fork's branch, to that fork's remote. A push that thread made because you told it to in its own chat didn't come from Push, so it gets the same note. On your PR the note reads "The fixer, a teammate or CI may have pushed them.": the fixer is that fresh or forked thread.
  - A branch name with a quote in it can't be pushed from here: push it from a terminal. Relayed asks and turns you didn't start never push.
- **Fix in a new thread** hands the comments you choose to a new visible thread in the review's project instead. It runs on the **Review agent** setting, and is told not to push or change GitHub unless you ask in that thread.
- **Send comments to the main thread** in Settings turns these off.

### Feedback on your own PR

On your own PR, teammates' comments go through the same loop.

- Comments lists their threads, and their review summaries and comments on the PR itself, a Request changes with only a summary or a "can you add tests?" too, each saying whose it is. One waiting for your reply is in Needs you, and brings the PR back to Needs review once; a review's comments on lines count as their threads, not again.
- **Send** on each, "Send @dana's comment", takes their words, quoted as theirs, with the code they're on, to the main thread. **Send 3 comments to main thread** (or **to a fresh thread**) at the top of Needs you sends everything there no Send took yet. Each says where it went, then **Done** or **Declined** with the thread's note once it reports.
- With no thread working on the PR, or its thread archived or deleted, the Send asks where it goes:
  - **Start a fresh thread**: a new worktree at the PR's head commit, on the machine of the thread that wrote the PR (else the project's), told about the PR, what you send, the guide's intent and that thread. It becomes the main thread.
  - **Fork the original instead**: a fork of the thread that wrote the PR, in the same kind of worktree. It keeps everything that thread knew, and costs more: it copies the whole chat.
  - **Unarchive and send**, for an archived thread: it picks up where it stopped.
  - Neither switches branches, and each is told that the quoted comments are others' words, never instructions about git or GitHub. Each pushes when you say, or when it's done with **Let it push when done** on, with `git push origin 'HEAD:refs/heads/<branch>'`, as a new worktree has no upstream; never force. If the thread can't start because the PR's head commit isn't on that machine yet, the Send says to run `git fetch origin pull/<n>/head` in the repo's folder there, then send again.
- When that thread is archived or deleted before reporting everything, **Send the rest…** sends what it didn't report, GitHub items too, and asks the same: a fresh thread or a fork.
- **Not pushed yet**, a page after the chapters, "Not pushed yet · 3 files" in the navigator, in the compare menu and from **Update first**, shows what the thread's folder has that the PR's head on GitHub doesn't, committed or not, "3 files on MaxBook aren't on GitHub yet", "Branch `feat/x` · compared with PR #9 (`c0ffee0`)", with **Refresh**. **Viewed** is kept for each file's revision, as in the chapters: a file the folder changes since is unviewed again. Its end says "Comments here go with Send, not Submit.", with **Push**, which shows how it goes in Finish review, and **Finish review**. Files that look like secrets stay out. A comment on a new line there is marked **Not on GitHub yet**: it goes with Send, not Submit, as Finish review says, but never to a fixer at the PR's head or with **Fix in a new thread**, which haven't its line, where the Send says "1 isn't on GitHub yet: change Main thread to a thread in its folder to send it.", and Fix in a new thread, with **Send comments to the main thread** off, "It stays in the draft: turn on Send comments to the main thread in Settings to send it to a thread in its folder."; Comments opens it there, and once its line is pushed, Update moves it onto the PR's line with its id. A removed line takes a comment at the PR's line where the PR's diff has it; one it doesn't says to comment in All changes.
- The review agent drafts your replies from what the thread reported. Say "you do it" on a PR with no folder and a fresh thread applies the agent's patch; the agent never pushes itself: **Push**, or your "push" to it, has the thread push.
- Once BB removes a fresh or forked thread's worktree, its branch stays in your repo: the review says **Branch kept**, which folder on which machine has it, and `git branch -D <branch>` to copy, which also deletes any commits on it that aren't on GitHub; then **Got it**. Code Review Workspace runs no git in your checkout.

## Customize your reviews

Open **Settings** from ⚙ in BB's title bar on All reviews, or **Review settings…** in a review's ⋯ menu, or use Code Review Workspace's section in BB's plugin settings. Its page goes back where you opened it from: **All reviews** or **Back to review**. Its sections:

- **Ready to review**: your GitHub account and its switcher.
- **Plugin updates**.
- **Notifications**.
- **Guide generation**: **Guide writer agent**, **Detail level**, **Guide instructions**, and Stop.
- **Review agent**: the **Review agent** setting, its instructions and prompts.
- **Whose turn**: how reviews come back to you.
- **Re-reviews**: what a re-review opens on, what changed since your review or all changes.
- **Reading**.
- **Comments and Finish review**.
- **BB's thread list**.
- **Trust**: who agents run for on their own; see [Who agents run for on their own](#who-agents-run-for-on-their-own).

Save settings to apply them across this installation. Restore defaults stages a change for you to save; it does not change settings immediately, and keeps the diff's layout and how new and deleted files show. Those are set in a review's Diff options, for every review.

### Feature switches

These switches turn a feature off; each is on by default. A setting that depends on another is indented, and disabled while that one is off.

| Section | Setting | When it's off |
|---|---|---|
| Notifications | A guide is ready or failed | No Needs You alert for a built or failed guide. |
| Notifications | A review becomes your turn | No alert when a review comes back to you, a snooze ending included. |
| Guide generation | Stop a guide while it builds | No Stop: a guide runs until it's done. |
| Review agent | Let the review agent act when you ask | The review agent only drafts, as in 1.7.0: it's told never to post, and has no tools that post, merge, open a PR or send to the main thread. Turning it off reaches an agent already running at once. |
| Review agent | Help agents in your threads use bb review | Agents in your other threads get no skill for `bb review`, and it prints no link and has no `list`. |
| Review agent | Read REVIEW.md | The agents read AGENTS.md, CLAUDE.md, and Copilot's instructions only, and the Overview doesn't say when a PR changes them. |
| Review agent | Ask why you remove an agent's comment | No **Why?**: removals are counted as before. |
| Review agent | Run the automatic review | A ready guide starts no review; the prompt is kept. |
| Review agent | Re-check the agent's comments after new commits | The review agent doesn't check its drafts against new commits. |
| Review agent | Dig deeper on a chapter | No Dig deeper; use Ask agent. |
| Whose turn | Come back when you're mentioned | A mention doesn't bring a review back. |
| Whose turn | Get a review ready before alerting you | The alert comes at once, without rebuilding the guide or checking your feedback first. |
| Whose turn | Run the re-review check | The review agent doesn't check your earlier feedback; the prompt is kept. |
| Whose turn | Include PRs you've reviewed | Only requests for your review join the list. |
| Whose turn | Include your own PRs | Your PRs join only once you start a review of one; ones found before that you haven't started a review of go to Archive. |
| Reading | Open on the Overview when a review comes back | It reopens where you left it. |
| Reading | Single-key shortcuts | Only Esc works (see [Keyboard shortcuts](#keyboard-shortcuts)). |
| Reading | Comment keys | `e`, `x`, `1`–`4`, `0`, and `r` do nothing. |
| Reading | Fold files you've viewed | A file you mark viewed stays open. |
| Reading | Fold lockfiles and generated files | They open like any other file; diffs over 1,500 lines still fold. |
| Reading | Flag weakened tests | No chip on test files, and the agents aren't asked to check them. |
| Reading | Summarize lockfile changes | Lockfiles show only their diff, and the agents get no summary, though their pages still name a lockfile's new download hosts. |
| Reading | Requirements | The Overview doesn't list them; the review agent still checks them. |
| Reading | Commands in BB's command palette | The palette doesn't list them. |
| Reading | Code owners | No Owned by or yours on files; the review agent still reads CODEOWNERS to know your files. |
| Reading | Review changes above a thread's message box | Threads show no Review changes; `bb review` still starts a review, and a linked thread's Review tab stays. |
| Reading | Notice when a local review's code changes | No notice; update a local review's guide from Review actions. |
| Reading | Open in editor (local reviews) | Nothing offers it. |
| Reading | CI failures in the code | No failure notes on lines; the Overview still lists failing checks. |
| Reading | Comment on or ask about a failing check | A failing check's note and the Overview's failing checks offer View check only. |
| Comments and Finish review | Send comments to the main thread | Finish review offers Fix in a new thread only, cards have no Send now and don't say what you sent, and there's no Main thread tab. |
| Comments and Finish review | Ask agent about selected text | Selecting text only selects it; selected lines still offer Comment and Ask agent. |
| Comments and Finish review | Move comments on an older diff into the summary | You edit or remove them. |
| Comments and Finish review | Check before you approve | Finish review doesn't flag unviewed high-risk files or chapters read faster than your set pace. |
| Comments and Finish review | Keep pre-existing problems apart | The agent doesn't mark them, and they count and post like any comment. |
| Comments and Finish review | Show what the agent checked | Finish review doesn't say how many files the agent read or what it didn't check, and doesn't ask about it. |
| Trust | Start agents on their own | On other people's PRs, nothing starts until you click. |

**Flag chapters read faster than** sets Check before you approve's pace: 100 to 2,000 lines an hour, 500 by default.

If settings are slow or can't load, a review opens after about a second with the switches this browser last loaded, and takes your settings when they arrive; a browser that never loaded them uses the defaults.

### Other settings and defaults

| Section | Setting | Choices | Default |
|---|---|---|---|
| Plugin updates | Update automatically when idle | On or off | Off |
| Guide generation | Guide writer agent | Project defaults or Custom | Project defaults |
| Guide generation | Detail level | Concise, Standard, or Detailed | Standard |
| Guide generation | Guide instructions | Text, up to 12,000 characters | Blank |
| Review agent | Review agent | Project defaults or Custom | Project defaults |
| Review agent | Assistant instructions | Text, up to 2,000 characters | Blank |
| Review agent | Automatic review | Text, up to 12,000 characters; blank turns it off | A precision-first review prompt |
| Whose turn | When the author replies | Questions for you, or Any reply | Questions for you |
| Whose turn | Re-review check | Text, up to 12,000 characters; blank turns it off | A feedback-check prompt |
| Whose turn | After the author pushes | Do nothing, Check my feedback, or Check, and bring it back when everything's addressed | Do nothing |
| Whose turn | Track reviews from GitHub | On or off | On |
| Whose turn | Include team requests | On or off | Off |
| Whose turn | Start guides automatically | Up to 50 lines of `owner/repo`, `owner/*`, or `*` | None |
| Re-reviews | On a re-review, show | Changes since your review, or All changes | Changes since your review |
| Comments and Finish review | Flag chapters read faster than | 100 to 2,000 lines an hour | 500 |
| BB's thread list | Show reviews in the thread list | On or off | On |
| Trust | Run agents on their own for PRs from | Members and collaborators, or Anyone | Members and collaborators |
| Trust | Let the review agent run the repo's tests and linters | On or off | Off |
| A review's Diff options | Layout | Unified or Split, for every review | Split |
| A review's Diff options | New and deleted files | As file or As diff, for every review | As file |

**Detail level** sets how much each chapter says:

- **Concise**: two short sentences per chapter, and brief file summaries.
- **Standard**: each chapter's change, motivation, and key implications, in 2 to 6 sentences.
- **Detailed**: behavioral implications, important contracts, risks, and what deserves a closer read, in up to six substantive sentences per chapter, with low-signal changes kept brief.

Start guides automatically rejects a line that isn't `owner/repo`, `owner/*`, or `*`, and names it under the box.

### Instructions and prompts

- **Guide instructions** extend the bundled `code-review-workspace-generate` skill. They apply to new guides and to guides you update or rebuild; the output schema and complete file coverage remain validated.
- **Assistant instructions**, up to 2,000 characters, reach the review agent as hidden instructions; an idle conversation picks up changes on its next message.
- **Automatic review** is the review agent's first message when a guide is ready and the review has no conversation yet. By default it asks for a precision-first review: at most 10 comments, each confirmed in the code, with a note of how, and labeled with its severity, and a review summary with the verdict it suggests by stated rules. On your own PR it's a self-review that suggests Comment. Settings saved with an earlier default use the new one. Turn off **Run the automatic review** to stop it and keep the prompt; leaving the prompt blank stops it too.
- **Re-review check** is the review agent's first message when a review comes back to you; see [When a review comes back](#when-a-review-comes-back).

### Learning from your edits

The review agent learns from what you remove.

- When you remove a comment it wrote, it's told not to raise it again unless the code changes.
- **Comment removed** offers **Why?** for an agent's comment: **Wrong**, **Intended**, **Already known**, or **Not worth it**, in one tap, with an optional note; choosing it closes the toast and its Undo. The agent sees your reason, and your note as data rather than instructions, and Settings splits the removals ("Removed 6: 3 wrong, 2 not worth it, 1 intended").
- Each submitted review records whether you kept, edited, or removed each of its comments, and Settings shows the tally ("Of the agent's last 40 comments you kept 31 as written, edited 6, removed 3") with the comments you removed lately.
- **Suggest instruction changes** asks the agent for up to five instruction lines from those removed and edited comments, and your reasons; you edit them, add them to Assistant instructions, and nothing applies until you save.

### Agents and machines

**Guide writer agent** and **Review agent** each choose **Project defaults** or **Custom**.

- A review's project is your Personal project, or the first project if there's none, for a review started from the panel, and the thread's project for one started with `bb review`.
- **Project defaults** runs on the BB server with the provider, model, and reasoning effort BB remembers for the review's project. The review agent takes the project's permission mode too; the hidden guide writer, which needs no shell or edits, runs at the lowest mode its provider runs in: Accept Edits, else Auto, else the project's.
- **Custom** pins all four, plus the service tier where the provider has one, with BB's pickers, starting from the Personal project's defaults, with the guide writer at Accept Edits, else Auto, else the provider's only mode (Accept Edits when the defaults can't be read).
- A provider that runs only at Full, as pi does, can't restrict its agent, and Settings says so under the picker, naming the providers that run at Accept Edits. Any reasoning level a provider offers can be saved.
- Custom also chooses the **Machine**: the BB server or another enrolled machine, such as your laptop. The pickers then list that machine's providers, models, and permission limit, and the agent runs in its Personal workspace with the agent configuration installed there; within the chosen permission mode, it can reach that machine's files and credentials.
- If the machine is offline or removed, building, updating, or rebuilding a guide, `bb review`, and a new review agent conversation fail at once and say why.
- Guide-writer changes apply to new guides and to guides you update or rebuild.
- The **Review agent** setting seeds the agent picker for a new conversation; within a conversation, change the model and effort per message as in any BB chat. A conversation keeps its provider and machine; to switch, start a **New conversation**.
- If BB can't start a custom agent (for example, its provider was disabled), the review agent shows the error; failed generation records it in the plugin log.

## Data and access

Review metadata, patches, generated guides, and drafts are stored in this BB installation's plugin database, or, if the BB operator chose it, in a Postgres database (see [Storage](#storage)). Review agents receive the patch and context through your configured BB provider; that provider's data handling applies. This plugin does not add a separate hosted review service.

### What the agents can and can't do

The plugin starts its agents in hidden BB threads and gives each only its role's tools. Only the review agent's write tools, given while **Let the review agent act when you ask** is on, post to GitHub, and what posts under your name waits for your click on **Post** or your yes (see [Posting when you ask](#posting-when-you-ask)).

**What's enforced, and what's only asked.** Everything this guide says the agents do or don't (posting only when you ask, the pushback, acting only on your words) is instructions to an agent that can have a shell on its machine, where `gh` is usually signed in: beyond the plugin's tools, it has what its provider and permission mode give it. Its instructions forbid GitHub writes from that shell, with `gh`, `gh api` or `git push`. Code enforces only what goes through the plugin's own tools and pages: who's asking, that what posts is exactly what the Post form showed, that only your click resolves, dismisses or reopens a comment, that on your own change only open comments post, the secrets filter on what agents read, and Push's check of a commit before the thread is told to push it. An agent with a shell can get round all of it, with `gh`, `git push`, or the plugin's own calls (`bb plugin rpc call code-review-workspace …`), and text in a PR could try to steer it there. With **Let the review agent act when you ask** off, the agent has no write tools and 1.7.0's rule to never post.

- **The guide writer** reads the review's diff, its file list, what changed since your review, and the PR's context, and submits the guide (`read_review_patch`, `list_review_files`, `read_changes_since_review`, `read_pr_context`, `generate_review_guide`). The plugin rejects a guide that leaves a changed file out or places one twice.
- **The review agent** reads the same, plus any file of the review at the PR's head, at the diff's start, or at the commit you last reviewed (`read_file`), your earlier feedback (`list_feedback`), and the local draft (`list_draft_comments`).
- In the local draft, it can add, edit, and delete draft comments, write the summary and suggest a verdict, reply in your discussions with it, record its check of your feedback, and draft replies to your threads for you to send (`add_draft_comment`, `edit_draft_comment`, `delete_draft_comment`, `set_review_summary`, `reply_in_discussion`, `assess_feedback`, `draft_thread_reply`).
- With **Let the review agent act when you ask** on, it also posts to GitHub and sends to the main thread when you ask (`submit_review`, `post_reply`, `resolve_thread`, `github_pr`, `open_pr`, `send_now`), as [Posting when you ask](#posting-when-you-ask) and [Who's asking](#whos-asking-and-the-approval-rule) say. Each checks the switch as it runs.
- It refuses to change a comment or summary you wrote, unless you asked on it, or asked in chat for a comment with the switch on.
- Each review's agents work only on their own review.
- Agents in your other BB threads get no tools from this plugin. With **Help agents in your threads use bb review** on, they get the `code-review-workspace` skill, and `bb review comment` and `bb review summary` change only the local draft. `bb review ask` relays to a review's agent, and `bb review approve` only lines approvals up for your click.

The review agent runs in the permission mode of its **Review agent** setting, on a machine whose `gh` login can usually write to GitHub, and the automatic review runs unattended; choose its permission mode with that in mind. The guide writer runs hidden and unattended too, using only Code Review Workspace's tools and one that reads a linked ticket; on Project defaults it runs at Accept Edits where its provider allows (see [Agents and machines](#agents-and-machines)). Claude Code, Codex, and OpenCode run at Accept Edits; pi runs only at Full, so an agent on pi runs at Full and can't be restricted, and Settings says so. The agents follow ticket references only in a trusted author's PR, and only ever read tickets: never write to an issue tracker or chat, or quote a private ticket into a draft. What agents write for GitHub is capped at 65,000 characters.

### Which threads count as a review's agents

- The review agent and the guide writer read only their own review's diff and PR context, and get their tools by the role the plugin recorded for their thread, whatever their thread is renamed to or its metadata says.
- One brief window remains: while a review's agent or guide writer is being started, typically well under a second, another of this plugin's threads titled exactly as the new one would count as it.
- A review's agent and guide writer can't use `bb review`, `bb review comment`, or `bb review summary` on another review, and a guide one starts on its own review doesn't count as your click. Neither can a review agent that New conversation replaced or found archived, nor an earlier guide writer, one a reload interrupted included, nor a review's thread that deleting the review couldn't stop or delete, and the **Suggest instruction changes** worker can't use them on any review.
- A review's own agents, and threads they started, can't use `bb review ask`, `approve`, `report` or `ready`, and a message from any of them to a review agent counts as no one's.
- `bb review` on a PR from one of your other BB threads counts as your click only for an author agents run for on their own (see below), and with **Start agents on their own** off only on your own PR; for anyone else, or when GitHub can't say, it builds the guide and leaves the run to your click.
- These limits hold for agents running `bb review` as BB starts it in their thread: BB tells the plugin which thread runs a command, and an agent with a shell can hide that. An agent with a shell in another thread can still run `bb review` commands on any review, and change Settings through the plugin's calls, as the panel does.

### What the agents read

- The agents read the repository's instructions (AGENTS.md, CLAUDE.md, `.github/copilot-instructions.md`, `.github/instructions`, and with **Read REVIEW.md** on, REVIEW.md at the root and in the changed files' directories and those above them) from the PR's base, or a local diff's start, never from the PR's head, and are told when the PR changes them.
- Which files are generated, from `.gitattributes`, is read at the PR's merge base too, so a PR can't fold its own code.
- The agents read a big diff in 80 KB pages, with lockfiles and generated and vendored files as one-line stubs that name a lockfile's new download hosts, in every lockfile format but go.sum, which holds no URLs, apart from its public registries (github.com counts as one for composer and Swift packages), and with a `\` ending a URL's host as package managers read it; a file the PR adds is always read in full.
- They're told when GitHub's 3,000-file list may have cut a huge PR short, and which files GitHub sent no diff for.
- **Ask agent** on an Overview's failing check runs `gh run view --log-failed` to read that check's log, only on that click; it writes nothing.

### Untrusted text

- Commit headlines, the earlier guide's chapters, CI logs, `bb review --context`, and your removal notes reach the agents fenced as untrusted text, and a changed path holding a line break or other control character is quoted.
- In other people's GitHub comments, the guide, CI annotations, the agents' words, and the review summary, images, named by their alt text, and videos show as links; HTML comments are hidden, as GitHub hides them; and other HTML shows as text, but for a few tags that only format (such as `details`, `summary`, `p`, `b`, `kbd`, lists, and tables, with attributes such as `open` and `align` only). A Markdown file shown rendered keeps its own HTML links too (see Rendered above).
- Code spans and fenced code, in table cells too, show as written where the plugin can tell they're code. Where it can't tell code from text, as inside an HTML block, after `$$` math or a footnote, or in a code span that a table's pipe splits, it treats the code as text: a `<` in it shows as `&lt;`, and an image as a link.

### Who agents run for on their own

The automatic review never starts on a PR already merged or closed. So agents start on their own (an auto-started guide, the automatic review, the feedback check) only on PRs from the repository's owner, members, and collaborators, and only when the PR's branch isn't in someone else's fork, whose owner can push to it.

- Change who under **Settings → Trust → Run agents on their own for PRs from**: members and collaborators (the default), or anyone, which lets a fork's branch run too.
- Turn off **Start agents on their own** to have other people's PRs wait for your click whoever wrote them; skipped runs then say "Start agents on their own is off in Settings".
- Your own PRs and local reviews always run, unless the PR's branch is in someone else's fork.
- On another author's PR, the list row and the review say what didn't run and why ("Not run automatically: @x isn’t a member of acme"), and the review offers one click to run it.
- An automatic review that couldn't start, as when its agent's machine is offline, says so and why ("Not run automatically: it couldn’t start (…)"), with **Run review** to try again; nothing retries on its own. **Run review** on a review whose conversation is under way sends the automatic review there.
- With **Run the automatic review** off, or on a merged or closed PR, **Run review** says why it can't run, and **Run check** does with **Run the re-review check** off; the notice stays.
- A run you start lets the automatic review and checks on that commit follow; each new push needs a new click, and so does an edit to the PR's title or description by an outside author after your click.
- Once you turn Start agents on their own back on, a run skipped while it was off says "Not run automatically: Start agents on their own was off in Settings when this came in".

### Running the repo's tests and linters

**Let the review agent run the repo's tests and linters**, off by default, lets the review agent run the commands the repository documents, in a temporary git worktree. **This runs the PR's code on the agent's machine**, with that machine's files and credentials in reach.

- It applies only to your own PRs and PRs from the authors you trust above, never to a branch in someone else's fork unless you trust anyone, and a click never allows it for others.
- With Start agents on their own off, the authors setting still decides whose PRs it runs on.
- With **Anyone** and this both on, Trust warns: "With Anyone, this runs code from any GitHub user’s PR, forks included, on this server, where gh is signed in."

### GitHub credentials

- GitHub operations use the server's `gh` credentials. No token needs to be pasted into the plugin.
- Replies, resolves, and unresolves you click post as the account the review verified, only on the review's own PR's threads. What the review agent posts goes as the account `gh` uses now, which its Post form names.
- Switching the account switches `gh` for everything on the BB server, other agents and terminals included, and the account menu says so. Switching starts each review afresh for the new account: its feedback check, held turn, click, skipped run, and alerts.
- Grant only the repository access your team needs.
- A shared BB server uses shared server credentials and plugin storage; it is not a multi-tenant review service.

### Storage

- The reviews are kept in SQLite, in the plugin's `data.db` on the BB server, unless the **Storage** setting (`storageBackend`) is Postgres. Then they're in a schema of the Postgres database the plugin's settings name, signed in with a password kept as a BB secret, over TLS by default. Moving them is the BB operator's: see [Storage backends](operations.md#storage-backends). `bb review storage status` says where they are.
- Reviews of PRs merged or closed for 30 days drop their stored diff to save space; the guide, draft, and notes stay, and opening one reads the diff from GitHub again. Open PRs, local reviews, guides for an earlier head, and drafts with comments keep theirs, but a folder's review archived for 30 days after BB removed its folder, with no comments, drops its diff for good.
- New reviews use repository-scoped identifiers, preventing equal PR numbers in different repositories from overwriting each other.

## Upgrading from older versions

Notes for reviews and pages from before the current releases. New installs can skip them.

- **Private notes:** reviewer notes are no longer a tool. Notes you wrote before 0.6.0 are under Finish review → Stays in BB → **Private notes**, only when you have some: saved in BB, and never included in GitHub submissions or agent prompts. Notes survive submission and archival. If saving fails, unsaved notes have a browser recovery copy; conflicting edits can be compared with the saved version before choosing what to keep. Existing review summaries retain their original public-draft meaning, and count as yours.
- **Clicks from 0.7.0:** a click from 0.7.0 on a PR edited since needs one more.
- **Pages from 0.7.0:** before a reply, resolve, or unresolve, a page from 0.7.0 is asked to reload first.
- **Older saved reviews** remain available. Legacy inline drafts must be removed and re-added against the current patch before submission.
- **Older conversations:** a review agent conversation from an earlier plugin version stays visible above the chat and reaches the first new message as context.
- **Coming from Guided Review:** see [Moving from Guided Review](../README.md#moving-from-guided-review).

## Troubleshooting

- **Setup checks fail.** **Settings → Ready to review** (or All reviews, with no reviews yet) says what's missing:
  - "GitHub CLI isn't on the BB server": install `gh` on the machine running BB, then check again.
  - "Sign in to GitHub on the BB server": run `gh auth login --hostname github.com` there. `gh auth status` shows which account `gh` uses.
  - "Your GitHub token is missing `read:org`": posting needs `repo`, and team reviewers `read:org`. Run the `gh auth refresh` command it shows on the BB server. Fine-grained tokens don't list their scopes, so Setup says it didn't check them.
  - "No BB agent to write guides": connect an agent provider in BB's Settings.
  - "No BB project to run guides in": add a BB project before starting a review.
- **All reviews can't read GitHub.** The list says why: GitHub CLI not on the BB server, `gh` not signed in, a rate limit (reading pauses for 15 minutes), or PRs or teams it can't see. Refresh's tooltip says when GitHub was last read.
- **"@you can't access acme/web. Switch account:"** or **"GitHub refused your account's credentials."** The review's notice offers the account switcher; switch, or give the account access to the repository. If a switch doesn't take, check whether `GH_TOKEN` or `GITHUB_TOKEN` overrides the saved account on the BB server.
- **A guide failed.** Its page says why under **What went wrong**, with **Try again**. `bb plugin logs code-review-workspace` keeps the error.
- **"Waiting for the guide writer's machine".** The guide writer's machine is offline. The guide restarts when it reconnects, for up to 10 minutes; **Try again**, or choose another **Machine** in Settings. See [Guides that stop or fail](#guides-that-stop-or-fail).
- **"Not run automatically: …".** The author isn't one agents run for on their own, or the branch is in someone else's fork. Click to run it, or see [Who agents run for on their own](#who-agents-run-for-on-their-own).
- **Submit warns.** New commits or a new base: **Update guide** first (**See the 2 commits** shows them), or **Submit anyway** (**Approve anyway**) on the version you reviewed. Comments on an older diff: edit, remove, or **Move to summary**, or Submit anyway moves them. A pending review you started on github.com needs submitting or discarding there (**Open it on GitHub**). See [When the PR changes](#when-the-pr-changes).
- **`bb review` refuses.** It must run in a project thread ("Run `bb review` inside a project thread."). A PR number or local ref needs a checkout on the BB server; pass the PR's URL instead.
- **A new file is missing from a local review.** A ref's review never includes untracked files: track it with `git add -N <file>`, then **Update**, or review the thread's folder with `bb review` alone (see [What each form reviews](#what-each-form-reviews)). A folder's review includes new files, but keeps secret-looking, binary and very large ones out until you bring them in (see [A thread's folder](#a-threads-folder)).
- **No Needs review group in BB's thread list, or no palette commands.** They need a BB with app overlays, and their switches on (**Show reviews in the thread list**, **Commands in BB's command palette**). A BB update that changes the thread list may hide the group until the plugin catches up.
- **No alerts.** Install Needs You 0.2.0-beta.3 or later, enable its **Extension activity**, and check **Settings → Notifications**.
- **"Couldn’t open the review session. The plugin may be updating."** Try again in a moment. If it stays, run `bb review storage status` on the BB server: in maintenance, or while it can't open its Postgres storage, it says why, and so does `bb plugin list`. See [Maintenance mode](operations.md#maintenance-mode).
- **The updater asks you to close pages after they're all closed.** See [docs/operations.md](operations.md#updates).
- **The review agent or the main thread beside a review, in two panes.** BB doesn't tell a plugin which pane's side panel a tab shows in, so with one review in two panes, **Ask agent** and **Show beside review** are pressed in both while either pane shows the tab. **Switch between review and main thread**, from a page that isn't a thread's, goes from the review you last clicked or typed in, else the one the window's address shows; and Review ↗ above a main thread's message box hides while the window's address is that review's. A key you bound to the switch instead of ⌘⇧. isn't in its tooltips: BB doesn't tell a plugin.
- **Anything else:** `bb plugin logs code-review-workspace` shows the plugin's log.

## Uninstall

- **One review:** **Delete…** in its **Review actions** (⋯) removes its guide, drafts, private notes, and agent conversation, after confirmation. Nothing changes on GitHub.
- **Pause the plugin:** `bb plugin disable code-review-workspace` stops it following your PRs and starting agents, and keeps its data.
- **Remove the plugin:** `bb plugin remove code-review-workspace` deletes its settings, and can delete its reviews and drafts: BB may keep `data.db`, but to keep them for sure, copy `data.db`, and any `data-export-…` or `data-backup-…` files beside it, off the server first. Reviews, replies, and resolves you already posted stay on GitHub. Reviews kept in Postgres stay there until the database's operator drops them; see [Removing the plugin](operations.md#removing-the-plugin).
- The `gh` sign-in on the BB server is GitHub CLI's own; sign out with `gh auth logout` if nothing else there needs it.
