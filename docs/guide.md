# Code Review Workspace guide

Everything Code Review Workspace does, in the order you'll meet it. For what it is and how to install it, start with the [README](../README.md).

Two agents work on each review. The **guide writer** is a hidden agent that writes the chaptered guide (**Guide writer agent** in Settings). The **review agent** drafts comments, the summary, and a suggested verdict, and answers you in **Ask agent** (**Review agent** in Settings).

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
5. Open **Finish review**, choose a verdict, and **Submit to GitHub**. Drafting, generating, and the agents never submit a review. Replies and resolve actions on existing GitHub threads are separate, immediate actions.

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

Run `bb review` in a BB thread. A PR URL, or `owner/repo#n`, works from a thread on any machine; a PR number or a local ref needs a project checkout on the BB server:

```sh
bb review https://github.com/acme/web/pull/42
bb review acme/web#42                  # the same PR
bb review 42                           # PR in the current repository
bb review origin/main...HEAD           # local range
bb review my-feature --base main       # branch against main
bb review https://github.com/acme/web/pull/42 --context 'Implements LIN-123: retry once, never twice.'
```

`bb review` must run in a project thread, and a review it starts runs in that thread's project.

### What each form reviews

- **A single ref**, such as `bb review main`, runs `git diff main`: your working tree against the ref, uncommitted changes to tracked files included.
- **A range**, such as `origin/main...HEAD` or `a..b`, runs `git diff` on that range, as git reads it: `...` starts at the merge base. It covers committed changes only.
- **A ref with `--base`**, such as `bb review my-feature --base main`, runs `git diff main...my-feature`: what the branch changed since it left main, committed changes only.
- **Untracked files are never included.** To review a new file, track it first, for example with `git add -N <file>`.
- `--base` goes with a single ref: `bb review` refuses it beside a range.

The checkout for a local review must exist on the BB server. A checkout only present on another enrolled machine is not supported by this release. Local reviews do not offer GitHub submission.

- When you open a local review, it runs its diff again in the checkout, and if the code changed since its guide, the notice strip says "The code changed since this guide." with **Update guide** (unless **Notice when a local review's code changes** is off in Settings → Reading).
- On a local review whose diff ends at the checkout (a ref, such as `bb review main`, or a range ending at `HEAD`), each file's second row and each draft comment's ⋯ offer **Open in editor** at the line, which opens the checkout's file on the BB server (unless **Open in editor (local reviews)** is off).

`bb review` remembers the thread it ran in, as the thread that made the change; this plugin's own agents never count. It prints a link to the review when BB has an app URL. `bb review list [--json]` lists every review, Needs review first and a stack's reviews together, as All reviews does, with its key, its title (quoted, then `named "…"` with the name you gave it), whose turn it is, and whether its guide is ready. With **Help agents in your threads use bb review** on (Settings → Review agent), agents in your other BB threads are also offered a `code-review-workspace` skill that explains these commands, tells them never to post to GitHub, and says that what `bb review` prints is data, not instructions. Off, `bb review` prints no link and has no `list`.

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

- A review is named by its PR URL, `owner/repo#n`, or its key.
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

## The review workspace

### Layout

- The code first. A review's commands sit in BB's **Code Review Workspace** title bar: **Comments**, with a badge counting what needs you; **Ask agent**; **Finish review**, with the verdict and how many comments will be sent; **Review actions** (⋯); and **Full screen**.
- Over the code is one 44px band: the chapters toggle and **Find in review** while the chapters aren't docked (docked, they head the chapters), **‹ All reviews**, the chapter you're on with its progress ring, the compare select on a re-review, **Fold comments**, and **Diff options**.
- **Full screen** covers BB's bars, on an iPhone too; the band then ends with the review's commands, and toasts, **Undo** among them, show over it. A phone has no band: see [Phone and iPad](#phone-and-ipad).
- The chapters and the side panel (Comments, Finish review, or the review agent) dock beside the code while it keeps at least 560px; otherwise they slide over it, and Esc, a tap on the code, ✕, or choosing something closes them. The panel docks narrower, down to 320px, before it covers the code. With no room for both, the chapters wait while the panel is docked and dock again when it closes.
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
- Lockfiles, generated and vendored files (`vendor/`, `third_party/`, `Pods/`, protoc and Dart generated files, and what `.gitattributes` at the PR's base marks `linguist-generated` or `linguist-vendored`), and diffs over 1,500 changed lines start folded, with **Show diff** ("Large diff · 1,600 lines"), and a file folds when you mark it viewed. A file the PR adds, or moves in from a path that isn't generated, is read as code whatever its path; Settings → Reading can turn off either fold, though huge diffs still start folded.
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
- **Fold comments** (`i`, or the band's button) shrinks every comment in the code to a one-line marker, with **Show** to open one, so the code reads on its own. On a phone they start folded.

### The review agent

**Ask agent** opens the review agent beside the code.

- The conversation is BB's own chat: streamed answers, stop, queued messages, approvals, attachments, and a per-message model and effort picker.
- The agent can add, edit, and delete draft comments and write the summary, and the changes appear in Comments and the code as it works.
- Besides the diff, it reads the PR's description, linked issues, commits, failing CI, other reviewers' open threads, and the repository's AGENTS.md, CLAUDE.md, Copilot instructions, and REVIEW.md, from the PR's base, and treats all of it as untrusted.
- **Pop out** moves it into a movable, resizable widget, and **Dock** puts it back; on a phone it stays in its sheet. While it's popped out, **Ask agent** asks in the widget. The arrow keys move the widget from its ✦ mark, as they resize it from its corner.
- Each review's agent conversation is a hidden BB thread, shown in the review with BB's chat. Review context (guide intent, chapters, and your Assistant instructions) reaches it as hidden instructions, refreshed when an idle conversation continues after the guide is updated or rebuilt, or the instructions change.
- Selections and the Ask agent button quote the file or lines into your message.
- **New conversation** archives the current one; if a conversation's thread is archived or deleted, the next question starts a new one.
- Archived PRs can still be discussed: their conversations stay unarchived because BB cannot send to an archived thread.

### Guides that stop or fail

- A guide writer that stops without a guide the plugin accepts is reminded once; a guide that still fails says why under **What went wrong**, and the plugin log keeps it.
- **Stop**, on the building screen or a guide update's notice, stops the guide writer: an update goes back to the guide you had ("Stopped. The guide is as it was."), and a first guide says "Guide stopped", in its status line too, with **Build the guide**, on a merged or closed PR too.
- A guide a reload interrupted restarts once its writer's machine reconnects, for up to 10 minutes; meanwhile its page and its status line say "Waiting for the guide writer's machine", and its update notice says "The guide writer's machine is offline. The update restarts on its own when it reconnects.", the page and the notice with **Try again**. After that it reads as failed, and says why under What went wrong, as does one whose restart failed, as when GitHub couldn't be read.

### Notices and Review actions

- One notice strip under the band says what to know: "New commits since this guide was written." with **Update guide** (or, when a stacked PR is retargeted, "The PR's base changed from parent to main since this guide was written."), "The code changed since this guide." on a local review, a guide update that failed and why, or one waiting for its writer's machine to reconnect, what didn't run on its own and why, a GitHub account that GitHub refuses for the repository (not when GitHub just can't be reached), or "Reconnecting…" while the connection to BB is down; the review reloads once it's back. While a guide updates, its notice offers **Stop**, which keeps the guide you had. **+N** shows the rest.
- **Review actions** (⋯) lists, in the same order everywhere: **Update guide** or **Rebuild guide**, **Snooze**, **Pin**, **Rename…**, **Archive**, **Open on GitHub**, **Keyboard shortcuts** (not on a phone), **Review settings…**, and **Delete…**.

### When the PR changes

A review is pinned to the PR snapshot it was generated from. If the PR gets new commits, or a new base, as when a stacked PR is retargeted after its parent merges, choose **Update guide** before submitting: Submit refuses a review of an older commit or base, and keeps your draft.

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

If you use speech input or press keys by accident, turn off **Single-key shortcuts** in Settings → Reading. Every key above goes, with the hints that name them, and `/` on All reviews too; Esc still closes what's over the code.

### Command palette

With **Commands in BB's command palette** on (Settings → Reading), BB's palette lists:

- **Code Review Workspace: Next review that needs me**, with ⌘⇧U (Ctrl+Shift+U) as its default key unless BB already uses it.
- **Code Review Workspace: Review PR from clipboard**, which opens the review of the PR link you copied, or starts one and names it ("Started a review of acme/web#7: Fix cache keys") with **Open**.
- **Code Review Workspace: All reviews**.

Give them keys of your own where BB lets you. The commands need a BB that supports app overlays, as the thread list's Needs review does (see [BB's thread list](#bbs-thread-list)); without them, the palette doesn't list them.

## Phone and iPad

- Every control is a 44px target on a touch screen, iPads included. The gutter's **+** shows only with a mouse or trackpad; on touch, tap a line, then another for a range.
- On an iPad, the layout is the desktop's at touch sizes, and a docked panel that no longer fits after a resize hides, and docks again when there's room.
- On a phone there's no band: a dock at the bottom holds **‹** (All reviews), the chapter you're on, **Comments**, **Ask agent**, and **Full screen**, and they open one sheet above it. Menus open as drawers from the bottom.

Every layout detail, held either way and on foldables such as the iPhone Duo, is in [docs/devices.md](devices.md).

## Whose turn

### All reviews

**All reviews** has four sections, in the order you'll work them. Needs review starts open and the others closed; each remembers what you chose, in this browser.

- **Needs review**: it's your turn. Reviews that came back to you (**Back to you**), new reviews and requests for your review (**New**), and **Team requests**, each longest-waiting first. **Blocks merge** marks a changes-requested review that's the only thing left, since everyone else approved; it comes first. Your own PRs show here as **Your PR** until you've reviewed them, then in Reviewed; they never wait on an author or alert.
- **Waiting on author**: you requested changes, or commented with threads still open, and the author hasn't said they're done. Rows show progress (`2/5 addressed`, `+1 nit`), new commits, CI, outdated threads, and how long the author has been quiet. Snoozed reviews wait here too.
- **Reviewed**: you approved, or commented with every thread resolved or answered. A push after your approval adds “updated” but doesn't bring it back.
- **Archive**: merged, closed, or archived by you; a PR found on GitHub that no longer requests you (**No longer requested**); and one GitHub hasn't found for 7 days (**Can't read on GitHub**).

Rows and the box:

- Each row is two lines: the title (your name for it, once you've [renamed](#rename) it, with the PR's title on hover), repository and number, and age (in Needs review, how long it's been your turn), then why it's yours and only the facts that change whether to open it, such as the PR's size (`+120 −30 · 8 files`).
- With a mouse, hovering a row shows **Snooze**, **Pin**, and **Archive**; on touch, every row has its **Review actions** (⋯).
- The box at the top finds a review, filtering the list by repository, @author, title (yours or the PR's), or #number, or takes a pasted PR link or `owner/repo#n`: **Open** the review if it's listed, or **Review** it to start one. `/` puts the cursor in the box; on a phone, ⌕ in BB's title bar opens it. The list keeps the box's filter when you come back from a review.
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

### Rename

- **Rename…** in a review's **Review actions** menu (⋯) gives it a name of your own. All reviews, BB's thread list, the review's band, Needs You alerts, and the title of a **Fix in a new thread** thread use it in place of the PR's title. It stays in BB: the PR keeps its title on GitHub, and the agents read that one.
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

Nothing posts to GitHub until you choose Send reply, Resolve, or Submit. **Get a review ready before alerting you**, on by default, holds the alert for this, at most 10 minutes; off, the alert comes at once, and **Update guide** and **Check again** are a click away. Change the check's instructions with **Re-review check** in settings, or turn it off with **Run the re-review check**, which keeps them.

### Since your review

On a re-review, the diff opens on what changed since your review, however you get to a chapter: Review changes, Continue, a chapter you pick, or a comment. To open on the whole PR instead, choose **All changes** under **Settings → Re-reviews**.

- A switch in each chapter's intro flips between the two in one tap, on every device, and says how many of the chapter's files changed: "Since your review · 1 of 3 files | All changes". A chapter with nothing new says "Nothing changed in this chapter since your review".
- **Since your review** shows only what changed since the commit you last reviewed, with new lines marked. It compares the PR's diff then with its diff now, so rebases and merges from the base branch don't show up as changes, and a diff that didn't change, as after a rebase, opens on all of it. Viewed marks survive a rebase, and chapters show how many of their files changed.
- The compare select in the band says what the diff shows too: **All changes**, **Since your review**, or since a commit. Its menu lists your last review, then the PR's earlier commits: pick one to see what changed since it ("Since abc1234"). On a PR you haven't reviewed, **Compare with a commit…** in Diff options does the same. Where the band has no room for the select, Diff options holds the comparison. A comparison that fails says why.
- What you choose holds for that review in this browser, a picked commit too, until the author pushes and its guide updates; then it opens on your Settings choice again. Opening a file or a line the comparison hides, from the chapters, a comment, or a Find result, shows all changes, and that holds too.

### Reviews found on GitHub

- With **Track reviews from GitHub** on (the default), PRs where your review is requested, and open PRs you've reviewed that changed in the last 60 days (unless **Include PRs you've reviewed** is off), join the list without a guide; build one with **Build the guide** on its page or in its menu.
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

- Its chips, **All**, **Needs you**, **Not submitted**, and **On GitHub**, show a count each and filter the list; on a touch screen they wrap to a second row where they don't fit.
- The list is grouped in that order: **Needs you** (a question for you, an author's reply, a thread the agent's check says isn't addressed, an agent reply draft, a comment on an older diff), **Not submitted · only in BB** (counted by severity, "1 blocking · 2 nits"), **On GitHub** (yours first, "Yours: 2 of 2 handled +1 nit", then other people's; resolved and outdated threads folded), and **Private · with the agent**, in reading order within each.
- Choosing a row shows its comment in the code, switching chapter and unfolding it if needed; its ⌄ opens the whole card in place, which is how file comments, outdated threads, and asks from your review summary read.
- ↻ reads GitHub again. ⋯ **Comment options** holds **Hide nits** (remembered in this browser, in the code too), **Remove nits**, **Show resolved threads**, **Add comment by line…**, and **Open PR on GitHub**.
- While you write a comment in the code, the list says where, with **Show in diff**.
- Comments on a local review stay in BB.

### Comment cards

Every comment is the same card in Comments and in the code, and says where it lives, in words as well as looks.

- Anything only in BB is dashed and says so: "Draft · not submitted", "Agent draft · not submitted" for one an agent wrote, until you edit it, and "Older diff · not submitted".
- A GitHub thread is solid, headed **On GitHub**, with who wrote each comment and when, who resolved it, and its state: "Waiting on author", "Author replied", "Question for you", "Resolved", "Outdated", or "File comment".
- A discussion with the agent is muted, with a lock: "Private · with the agent".
- An agent's draft can fold **How the agent checked** under its words: what it read or ran to confirm the problem, with file:line. That stays in BB; submitting never sends it.
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
- Changes from the review agent or `bb review comment` appear in Comments and the code as they happen. Agents can also edit and delete comments, and are told to change yours only when you ask. Nothing they do posts to GitHub.
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

**Finish review** (`s`, **Finish review** in BB's title bar, or the bar at Comments' foot, which says the verdict and how many comments will be sent; a phone's dock says "2 to send") holds what goes to GitHub when you submit: the summary, the verdict, and exactly what will be posted.

- **Summary · posted with your verdict:** the comment GitHub shows with your verdict, above the line comments. It works like a line comment. The review agent writes it, labeled "Agent summary · not submitted", and suggests a verdict; only you pick the verdict. **Edit** makes the summary yours, and **Remove** clears it. **Ask agent** opens a discussion with the agent under the summary: ask why, or say what to change, and the agent changes the summary there. **Undo** puts back its latest change. The agent never replaces a summary you wrote unless you ask on it, and then only while it answers that ask, not in work it was already doing. While it works on the summary, Edit waits; if the summary changes while you're editing it, the box says so before you save. When a summary the agent wrote no longer fits your comments, or the verdict you picked, it says so, with **Update**. With no summary, **Write summary** or **Ask agent to write it**. Since Move to summary can put an agent's words in it, the card shows any summary's images as links, yours too; GitHub gets it as written.
- **Verdict:** Approve, Comment, or Request changes, the agent's suggestion marked with a sparkle. "Agent suggests …" shows its suggested summary, or its check's, with **Use as draft**, **Request what's left**, and, when you picked another verdict, **Switch to** it. Beside it, Finish review says how many of the changed files the agent read as the change leaves them ("Read 6 of 8 files", lockfiles and generated files aside) and folds **What it didn't check**, as the agent wrote it (unless **Show what the agent checked** is off). On your own PR only Comment is offered, as GitHub refuses the others.
- **Goes to GitHub:** the comments and their severities, and anything to settle first, each with its fix: comments on an older diff (Submit waits until you edit and save them, remove them, or **Move to summary**), a Request changes without a summary (it waits for one), a verdict other than the agent's, or an approval with blocking comments. While you approve, it also flags files in high-risk chapters you haven't viewed ("2 files in high-risk chapters not viewed", with **Show**), and each medium- or high-risk chapter of 50 lines or more marked viewed faster than anyone reads ("Chapter 2 (high risk): 1,200 lines marked viewed in 3 min", past 500 lines an hour); lockfiles and generated files don't count. **Check before you approve** in Settings turns these off, and sets the pace. When the agent suggests Approve but didn't read every changed file, a row says so ("The agent suggests Approve but read 6 of 8 files", with **Show**). Pre-existing comments are counted apart. Reply drafts are listed too: they post on their own, with Send reply.
- **Stays in BB:** **Private notes**, only if you have some (see [Upgrading from older versions](#upgrading-from-older-versions)).
- **Submit to GitHub**, with your verdict on it ("Submit to GitHub · Approve · 1 blocking"), pinned at the foot, with where it posts and as whom. It asks once more (**Submit anyway**) when the verdict isn't the one the agent suggested, the agent's summary is out of date, or you approve with blocking comments, high-risk files not viewed, chapters read faster than your set pace, or files the agent didn't read; otherwise it's one click. It reads **Submitting…** while it posts, and waits while you're writing a comment or the summary. Submit refuses a draft whose comments, summary, or verdict changed since the page last showed them, or a page that doesn't send them. If GitHub's answer is lost or doesn't come within 5 minutes, Submit looks on GitHub for the review it just posted and finishes with it, rather than post it twice; if it can't check, it says to look at the PR before submitting again. If you started a pending review on github.com, Submit says to submit or discard it there, then submit again.

After you submit, the panel reads **Review submitted**: the verdict, where it posted and as whom, **View on GitHub**, **Add another review**, and the next review in Needs review, with **Open**. A merged or closed PR's Comments ends with "Merged · Archived" and **Open**: its **Archived review**, with the unsubmitted draft and notes to read.

### Hand comments to a coding thread

These appear in Finish review on your own PR or a local review.

- **Fix in a new thread** hands the draft comments you choose to a visible BB thread in the review's project. Its first message lists each comment with its file, lines, severity, and code, and the branch and commit you reviewed. It runs on the **Review agent** setting, and is told not to push or change GitHub unless you ask in that thread. The draft isn't changed or submitted.
- When you started the review with `bb review` in a thread, Finish review leads instead with **Send N comments to ‹thread›**, the thread that made the change, with "or Fix in a new thread" beside it. It sends only on your click, with the same picker and message, queued behind whatever that thread is doing, and asks it to reply with what it changed; nothing goes to GitHub. The picker also takes an optional message, sent before the comments, and **Include the summary**, unchecked, which adds the review summary after them.
- Then it says "Sent to ‹thread›" or "Queued in ‹thread›", with **Open**, and each comment you sent says "Sent to ‹thread› · 2m" on its card, still not submitted, until you edit it.
- With no comments in the draft, it offers **Send approval to ‹thread›** instead. It opens a small form: an optional message, and **Include the summary**, unchecked, when the draft has a summary. **Send** tells that thread "Approved", then your message and the summary if you add them, queued behind whatever it's doing; nothing goes to GitHub. It's offered once for each diff you review; add a comment and the comments go as above.
- If that thread was archived or deleted, only Fix in a new thread is offered, and Finish review says why.
- **Send comments to the thread that made the change** in Settings turns it off.

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
| Reading | Notice when a local review's code changes | No notice; update a local review's guide from Review actions. |
| Reading | Open in editor (local reviews) | Nothing offers it. |
| Reading | CI failures in the code | No failure notes on lines; the Overview still lists failing checks. |
| Reading | Comment on or ask about a failing check | A failing check's note and the Overview's failing checks offer View check only. |
| Comments and Finish review | Send comments to the thread that made the change | Finish review offers Fix in a new thread only, and cards don't say what you sent. |
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

The plugin starts its agents in hidden BB threads and gives each only its role's tools. None of these tools posts to GitHub, submits a review, sends a reply, or resolves a thread: only your click in the review does.

- **The guide writer** reads the review's diff, its file list, what changed since your review, and the PR's context, and submits the guide (`read_review_patch`, `list_review_files`, `read_changes_since_review`, `read_pr_context`, `generate_review_guide`). The plugin rejects a guide that leaves a changed file out or places one twice.
- **The review agent** reads the same, plus any file of the review at the PR's head, at the diff's start, or at the commit you last reviewed (`read_file`), your earlier feedback (`list_feedback`), and the local draft (`list_draft_comments`).
- It can change only the local draft: add, edit, and delete draft comments, write the summary and suggest a verdict, reply in your discussions with it, record its check of your feedback, and draft replies to your threads for you to send (`add_draft_comment`, `edit_draft_comment`, `delete_draft_comment`, `set_review_summary`, `reply_in_discussion`, `assess_feedback`, `draft_thread_reply`).
- It refuses to change a comment or summary you wrote, unless you asked on it.
- Each review's agents work only on their own review.
- Agents in your other BB threads get no tools from this plugin. With **Help agents in your threads use bb review** on, they get the `code-review-workspace` skill, and `bb review comment` and `bb review summary` change only the local draft.
- **What the plugin doesn't limit:** beyond these tools, an agent has what its provider and permission mode give it, such as a shell on its machine. Its instructions forbid GitHub writes, but text in a PR could try to steer it. See below.

The review agent runs in the permission mode of its **Review agent** setting, on a machine whose `gh` login can usually write to GitHub. Its instructions forbid GitHub writes, but text in a PR could try to steer it, and the automatic review runs unattended; choose its permission mode with that in mind. The guide writer runs hidden and unattended too, using only Code Review Workspace's tools and one that reads a linked ticket; on Project defaults it runs at Accept Edits where its provider allows (see [Agents and machines](#agents-and-machines)). Claude Code, Codex, and OpenCode run at Accept Edits; pi runs only at Full, so an agent on pi runs at Full and can't be restricted, and Settings says so. The agents follow ticket references only in a trusted author's PR, and only ever read tickets: never write to an issue tracker or chat, or quote a private ticket into a draft. What agents write for GitHub is capped at 65,000 characters.

### Which threads count as a review's agents

- The review agent and the guide writer read only their own review's diff and PR context, and get their tools by the role the plugin recorded for their thread, whatever their thread is renamed to or its metadata says.
- One brief window remains: while a review's agent or guide writer is being started, typically well under a second, another of this plugin's threads titled exactly as the new one would count as it.
- A review's agent and guide writer can't use `bb review`, `bb review comment`, or `bb review summary` on another review, and a guide one starts on its own review doesn't count as your click. Neither can a review agent that New conversation replaced or found archived, nor an earlier guide writer, one a reload interrupted included, nor a review's thread that deleting the review couldn't stop or delete, and the **Suggest instruction changes** worker can't use them on any review.
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
- In other people's GitHub comments, the guide, CI annotations, the agents' words, and the review summary, images, named by their alt text, and videos show as links; HTML comments are hidden, as GitHub hides them; and other HTML shows as text, but for a few tags that only format (such as `details`, `summary`, `p`, `b`, `kbd`, lists, and tables, with attributes such as `open` and `align` only).
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
- Replies, resolves, and unresolves post as the account the review verified, only on the review's own PR's threads.
- Switching the account switches `gh` for everything on the BB server, other agents and terminals included, and the account menu says so. Switching starts each review afresh for the new account: its feedback check, held turn, click, skipped run, and alerts.
- Grant only the repository access your team needs.
- A shared BB server uses shared server credentials and plugin storage; it is not a multi-tenant review service.

### Storage

- The reviews are kept in SQLite, in the plugin's `data.db` on the BB server, unless the **Storage** setting (`storageBackend`) is Postgres. Then they're in a schema of the Postgres database the plugin's settings name, signed in with a password kept as a BB secret, over TLS by default. Moving them is the BB operator's: see [Storage backends](operations.md#storage-backends). `bb review storage status` says where they are.
- Reviews of PRs merged or closed for 30 days drop their stored diff to save space; the guide, draft, and notes stay, and opening one reads the diff from GitHub again. Open PRs, local reviews, guides for an earlier head, and drafts with comments keep theirs.
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
  - "No BB agent to write guides": connect an agent provider in BB's Settings.
  - "No BB project to run guides in": add a BB project before starting a review.
- **All reviews can't read GitHub.** The list says why: GitHub CLI not on the BB server, `gh` not signed in, a rate limit (reading pauses for 15 minutes), or PRs or teams it can't see. Refresh's tooltip says when GitHub was last read.
- **"@you can't access acme/web. Switch account:"** or **"GitHub refused your account's credentials."** The review's notice offers the account switcher; switch, or give the account access to the repository. If a switch doesn't take, check whether `GH_TOKEN` or `GITHUB_TOKEN` overrides the saved account on the BB server.
- **A guide failed.** Its page says why under **What went wrong**, with **Try again**. `bb plugin logs code-review-workspace` keeps the error.
- **"Waiting for the guide writer's machine".** The guide writer's machine is offline. The guide restarts when it reconnects, for up to 10 minutes; **Try again**, or choose another **Machine** in Settings. See [Guides that stop or fail](#guides-that-stop-or-fail).
- **"Not run automatically: …".** The author isn't one agents run for on their own, or the branch is in someone else's fork. Click to run it, or see [Who agents run for on their own](#who-agents-run-for-on-their-own).
- **Submit refuses.** New commits or a new base need **Update guide** first; comments on an older diff need editing, removing, or **Move to summary**; a pending review you started on github.com needs submitting or discarding there. See [When the PR changes](#when-the-pr-changes).
- **`bb review` refuses.** It must run in a project thread ("Run `bb review` inside a project thread."). A PR number or local ref needs a checkout on the BB server; pass the PR's URL instead.
- **A new file is missing from a local review.** Untracked files are never included. Track it with `git add -N <file>`, then **Update guide**. See [What each form reviews](#what-each-form-reviews).
- **No Needs review group in BB's thread list, or no palette commands.** They need a BB with app overlays, and their switches on (**Show reviews in the thread list**, **Commands in BB's command palette**). A BB update that changes the thread list may hide the group until the plugin catches up.
- **No alerts.** Install Needs You 0.2.0-beta.3 or later, enable its **Extension activity**, and check **Settings → Notifications**.
- **"Couldn’t open the review session. The plugin may be updating."** Try again in a moment. If it stays, run `bb review storage status` on the BB server: in maintenance, or while it can't open its Postgres storage, it says why, and so does `bb plugin list`. See [Maintenance mode](operations.md#maintenance-mode).
- **The updater asks you to close pages after they're all closed.** See [docs/operations.md](operations.md#updates).
- **Anything else:** `bb plugin logs code-review-workspace` shows the plugin's log.

## Uninstall

- **One review:** **Delete…** in its **Review actions** (⋯) removes its guide, drafts, private notes, and agent conversation, after confirmation. Nothing changes on GitHub.
- **Pause the plugin:** `bb plugin disable code-review-workspace` stops it following your PRs and starting agents, and keeps its data.
- **Remove the plugin:** `bb plugin remove code-review-workspace` deletes its settings, and can delete its reviews and drafts: BB 0.46 keeps `data.db`, but to keep them for sure, copy `data.db`, and any `data-export-…` or `data-backup-…` files beside it, off the server first. Reviews, replies, and resolves you already posted stay on GitHub. Reviews kept in Postgres stay there until the database's operator drops them; see [Removing the plugin](operations.md#removing-the-plugin).
- The `gh` sign-in on the BB server is GitHub CLI's own; sign out with `gh auth logout` if nothing else there needs it.
