# Guided Review

An agent-authored walkthrough of a GitHub pull request or local Git change, inside [BB](https://getbb.app). Read the change in chapters, inspect the diff, ask questions, and prepare your review in one workspace.

**v0.6.0.** Each reviewer uses their own BB installation and GitHub identity. On a shared BB server, credentials, settings, and saved reviews are shared.

## Install and first run

You need **BB 0.41+ with Node 24+**, a configured BB agent provider, and `git` and GitHub CLI (`gh`) on the **machine running BB**. GitHub features support github.com. Installation uses prebuilt bundles; no npm or build step is needed.

Add the marketplace once, then install Guided Review:

```sh
bb marketplace add git:github.com/notpritam/bb-marketplace@main
bb marketplace refresh notpritam
bb plugin install guided-review@notpritam
```

Or open **Extensions**, search **Guided Review**, and choose **Install** after adding the marketplace. Direct Git installation can also follow compatible releases:

```sh
bb plugin install git:github.com/notpritam/bb-plugin-guided-review@^0.2.0
```

1. Open **Guided Review**. With no reviews yet, **All reviews** checks your setup and says how to start; you can revisit it in **Settings → Ready to review**.
2. Sign in on the BB server with `gh auth login --hostname github.com`. Check the account displayed in Guided Review and its access to the repository. No token is pasted into the plugin.
3. Paste a GitHub PR link into the box on **All reviews** and choose **Review**, or press Enter. Your BB agent writes the chaptered guide using its normal usage allowance. When the guide is ready, the review assistant reviews the change, adds draft comments, and writes a review summary with the verdict it suggests. On PRs from outside your repository's members and collaborators, agents wait for your click (see [Data and access](#data-and-access)).
4. The review opens on its Overview; **Start reading** takes you through the chapters. Edit or remove the assistant's draft comments and summary, or ask it to change them, add your own, or ask the assistant about a file or selection.
5. Open **Finish review**, choose a verdict, and **Submit to GitHub**. Drafting, generating, and the assistant never submit a review. Replies and resolve actions on existing GitHub threads are separate, immediate actions.

GitHub account switching affects `gh` on the BB server. Environment tokens can override saved-account selection; the plugin reports when a switch has not taken effect. Review submissions verify the displayed account and use its credential for the entire request.

## Updates

Open **Settings → Plugin updates** to check for a compatible release, read its release notes, and choose **Update now**. Save or discard settings edits and close other Guided Review pages first. BB installs the latest compatible release available at installation time; it may advance beyond the version shown by an earlier check.

**Automatic updates are off by default.** If enabled, the plugin checks hourly after five idle minutes and waits until all Guided Review and Settings pages are closed, with no generation, save, or submission in progress. Assistant conversations run in BB and continue across plugin updates. Reviews, drafts, private notes, conversations, and preferences remain in BB. Failed checks are visible and retried later; BB handles failed-install rollback.

Marketplace installs track `^0.2.0` (compatible 0.2.x releases). Catalog refresh only refreshes listings. You can also update with `bb plugin update guided-review`; close the plugin’s pages first, since BB’s external update command does not use the in-plugin activity guard. Local directories and exact tags are pinned and do not receive automatic updates. Changing a local installation to a marketplace source is a separate migration: this BB version requires removing the old source first, which can clear plugin data. Do not remove an existing installation just to obtain updates; keep its data and arrange a backup/migration with the BB operator. Fresh marketplace installs are ready for normal updates.

An interrupted browser connection can leave an editing session protected. If the updater still asks you to close pages after they are all closed, save any work elsewhere and reload the plugin through BB. Editing sessions intentionally never expire while a laptop might still hold unsaved text.

## Local changes and the command line

Run `bb review` in a BB thread. A PR URL works from a thread on any machine; a PR number or a local ref needs a project checkout on the BB server:

```sh
bb review https://github.com/acme/web/pull/42
bb review 42                           # PR in the current repository
bb review origin/main...HEAD           # local range
bb review my-feature --base main       # branch against main
bb review https://github.com/acme/web/pull/42 --context 'Implements LIN-123: retry once, never twice.'
```

The checkout for a local review must exist on the BB server. A checkout only present on another enrolled machine is not supported by this release. Local reviews retain notes in BB and do not offer GitHub submission.

`--context` adds text, such as the ticket a PR implements, to the assistant's automatic review. It's kept with the review: running `bb review` again without it keeps it, and `--context ''` removes it. It reaches only the automatic review, which runs when a guide is ready and the review has no conversation yet; the command says when it won't.

Other BB threads and scripts can work with a review's draft comments. These commands change only the local draft; nothing is posted to GitHub until you submit:

```sh
bb review comment list   https://github.com/acme/web/pull/42 [--json]
bb review comment add    https://github.com/acme/web/pull/42 src/api.ts:57 --code 'return cache.get(key);' --body 'Stale after a write?'
bb review comment add    https://github.com/acme/web/pull/42 src/api.ts:57-58 --code $'return cache.get(key);\n}' --body 'Read through on a miss.' --severity should-fix
bb review comment edit   https://github.com/acme/web/pull/42 src/api.ts:57 --body 'Can this return stale data after a write?'
bb review comment delete https://github.com/acme/web/pull/42 src/api.ts:57
```

A review is named by its PR URL or its key. Line numbers count in the new file; add `--side LEFT` for a removed line, numbered in the old file. `--code` is that line's text, and `add` refuses a line that doesn't match it or already has a comment. `path:57-58` comments on a range of lines in one hunk; `--code` then holds the range's lines, one per line (in a shell, `$'a\nb'`), and GitHub gets a multi-line comment. `--severity blocking|should-fix|question|nit|none` sets the comment's severity; a body that starts with a label, such as `**Blocking:**`, sets it too. `list` shows each comment's range and severity. Comments added this way show as added by an agent.

The review summary works the same way. `--suggest` marks the verdict you'd suggest; the reviewer still picks it. A summary the reviewer wrote is refused, unless they asked on it:

```sh
bb review summary https://github.com/acme/web/pull/42 [--json]
bb review summary https://github.com/acme/web/pull/42 --body 'One blocker: the retry can double-charge (`src/pay.ts:88`).' --suggest REQUEST_CHANGES
```

## What the review workspace includes

- The code first. A review's commands sit in BB's **Guided Review** title bar: **Comments**, with a badge counting what needs you; **Ask agent**; **Submit review**, with how many comments will be sent; **Review actions** (⋯); and **Full screen**. Over the code is one 44px band: the chapters toggle and **Find in review** while the chapters aren't docked (docked, they head the chapters), **‹ All reviews**, the chapter you're on with its progress ring, the compare select on a re-review, **Fold comments**, and **Diff options**. **Full screen** covers BB's bars, on an iPhone too; the band then ends with the review's commands, and toasts, **Undo** among them, show over it. A phone has no band: see [Phone and iPad](#phone-and-ipad).
- The chapters and the side panel (Comments, Finish review, or the review agent) dock beside the code while it keeps at least 560px; otherwise they slide over it, and Esc, a tap on the code, ✕, or choosing something closes them. The panel docks narrower, down to 320px, before it covers the code. With no room for both, the chapters wait while the panel is docked and dock again when it closes. Drag the line between a side and the code to resize it; double-click or double-tap it for the default width. Widths are kept for every review.
- A review opens on its **Overview** the first time, and whenever it comes back to you: the title, which opens the PR; the author, repository, and branches; the changed lines to read with a rough reading time (about 400 lines an hour, without lockfiles and generated files); a status line in All reviews' words (whose turn, **Blocks merge**, your feedback's progress, checks); your earlier reviews and the stack; then **Start reading**, **Continue** where you were, or **Review changes** at the first chapter that changed since your review, with **Snooze** while it's your turn. Below come **Since your review**; **What and why**; **Start here**, the guide's one to three riskiest lines, each opening its line; **Requirements · 3 of 4 covered**, what the PR's description and linked tickets ask for and whether the diff does it, with evidence and a link to the line; failing and pending checks with **View check**; and the chapters. When the review came back to you, Comments opens on what needs you where it can sit beside the code in BB's pane, or a "3 need you" pill offers it until you scroll. Otherwise a review reopens where you left it, scroll position included.
- Ordered chapters with intent, file summaries, risk labels, and changed-line counts. The chapters list, **Chapters | All files**, starts with the Overview, which says where the review stands, then a bar of viewed files with **Next unviewed**, then each chapter; on a phone the switch heads the chapters sheet, and the files viewed share the bar's row. Each chapter opens on an intro: one line ("Chapter 1 of 3 · Medium risk · 3 files · 27 lines · 0 of 3 viewed"), its title, and its overview; medium- and high-risk chapters add **What to verify**, one to three things to check. On a phone the overview shows three lines until **More**, and **What to verify · 2 ›** is one line that opens the list. Every changed file appears in one chapter, except that a guide can split a file mixing unrelated changes: each chapter then shows only its hunks, with an "Also in" note. Files the guide leaves unplaced appear in a last **Other files** chapter. A chapter ends with what you've viewed and commented, **Mark viewed and continue**, and **Next: …**; the last one offers **Mark viewed and finish** or **Finish review**, and names the files you haven't viewed yet.
- **Mark chapter viewed** works on any chapter: on the open chapter's card in the chapters list, from the ✓ another chapter shows on hover or focus with a mouse, with `⇧V`, or at the chapter's end. **Undo** in its toast puts every file back as it was.
- Syntax-highlighted diffs and viewed-file tracking. Only a slim row sticks above each file's code: its path, its comment count (drafts and unresolved GitHub threads), its additions and deletions, and **Viewed**. Under it, a row that scrolls away holds the guide's one-line summary, Renamed, Also in, the file's owners, "Changed since you viewed it" on a viewed file that changed again, **Show diff**, **Expand**, and **Whole file**. Lockfiles, generated files (including what `.gitattributes` marks `linguist-generated` or `linguist-vendored`), and diffs over 1,500 changed lines start folded, with **Show diff**. **Expand** loads the whole file, to expand around its hunks; **Whole file** shows every line. Comments still go only on lines in the diff.
- **Diff options** (⚙, at the band's end) holds how the code draws: **Layout**, Unified or Split (saved for every review; the diff goes unified when its pane is narrower than 960px, and says Split needs a wider pane); **Wrap long lines**; **Hide whitespace changes**, which shows whitespace-only changes as unchanged, like `git diff -w`; **GitHub threads in code** (remembered in this browser); **Collapse all** and **Expand all** for the chapter's files; and, with a mouse or trackpad, **Keyboard shortcuts**. Where the band has no room for them, it also holds **Fold comments in code** and the comparison (see [Whose turn](#whose-turn)). On a phone, and on one held sideways, it opens as a drawer from the bottom, without Layout: the diff is unified there.
- CODEOWNERS owners on each file ("Owned by …"), read from the PR's base branch as GitHub does. Files you or your teams own are marked **yours**, and the assistant is told which they are.
- **All files** switches the chapters list to every changed file as a folder tree, with a filter; each file shows whether it's viewed, its comments and discussions, whether it changed since your review, its kind, and its owners. **Find in review** searches every line of the diff, both sides, and the guide's text; a result opens its line in its chapter.
- Comments in the code, under their lines, as on GitHub, each with all its actions, so a whole re-review can happen in the code. With a mouse, click **+** beside a line to write one there, or select lines and choose **Comment** in the selection bar; on an iPad or phone, tap a line to select it, tap another to make a range, then choose **Comment**. Several lines make a range comment ("Lines 10–15"), sent to GitHub as a multi-line comment. **Suggest change** in the comment box inserts a suggestion block with the new lines' current text, and draft cards show it as the code it would put in place. Edit or remove a comment in place; Cmd/Ctrl+Enter saves and Esc cancels.
- One card for each comment, the same in the code and in Comments, that says where the comment lives, in words as well as looks: anything only in BB is dashed and says **not submitted**; a GitHub thread is solid, headed **On GitHub**, with who wrote each comment and when; a private discussion with the agent is muted, with a lock. See [Comments and Finish review](#comments-and-finish-review).
- Everyone's GitHub review threads under their lines, with **Reply** and **Resolve**. Resolved and outdated threads are folded; outdated threads and file comments wait in their file's fold, "Outdated (1) · File comments (1)". **GitHub threads in code** in Diff options hides them all. CI failures with annotations show on their lines too, with **View check**.
- **Fold comments** (`i`, or the band's button) shrinks every comment in the code to a one-line marker, with **Show** to open one, so the code reads on its own. On a phone they start folded.
- Discussions with the assistant under a line, kept apart from its comment. **Ask agent** on a comment opens a box under it: say what's wrong or ask why, and the assistant answers there, or edits or removes the comment. **Undo** puts back its latest change. **Ask agent** in the comment box, or on selected lines, asks about the lines without adding a comment; text selected in the code, a long-press included, offers **Ask agent about selection**. Discussions stay in BB: submitting sends only the comments, and clears the discussions.
- **Comments** beside the code, one list of your draft comments and the agent's, everyone's GitHub threads, and your discussions with the agent; and **Finish review**, which gathers the summary, the verdict, and exactly what will be posted (see [Comments and Finish review](#comments-and-finish-review)).
- **Ask agent** opens the review agent beside the code. The conversation is BB’s own chat: streamed answers, stop, queued messages, approvals, attachments, and a per-message model and effort picker. The assistant can add, edit, and delete draft comments and write the summary, and the changes appear in Comments and the code as it works. Besides the diff, it reads the PR's description, linked issues, commits, failing CI, other reviewers' open threads, and the repository's AGENTS.md, CLAUDE.md, and Copilot instructions, and treats all of it as untrusted. **Pop out** moves it into a movable, resizable widget, and **Dock** puts it back; on a phone it stays in its sheet.
- One notice strip under the band says what to know: "New commits since this guide was written." with **Update guide**, a guide update that failed, what didn't run on its own and why, or a GitHub account that can't read the repository. **+N** shows the rest.
- **Review actions** (⋯) lists, in the same order everywhere: **Update guide** or **Rebuild guide**, **Snooze**, **Pin**, **Archive**, **Open on GitHub**, **Keyboard shortcuts** (not on a phone), **Review settings…**, and **Delete…**.

A review is pinned to the PR snapshot it was generated from. If the PR gets new commits, choose **Update guide** before submitting: Submit refuses a review of an older commit, and keeps your draft. Unsent draft comments follow their lines into the new diff; a comment whose line is gone is marked **Older diff**: edit and save it, or remove it, before submitting. Submission failures retain the draft; repeated clicks cannot submit the same draft concurrently. Unsaved summaries and comments keep a recovery copy in this browser tab, bound to their original review revision. While the guide updates, the current one stays, with your unsaved edits.

### Keyboard shortcuts

| Key | Action |
|---|---|
| j / k | Next or previous file |
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
| Esc | Close what's over the code, or leave full screen |
| i | Fold or unfold comments in the code |
| ⇧F | Full screen on or off |
| ? | Show these shortcuts |

They work anywhere in a review, its commands in BB's title bar included, except while you type, inside a panel open over the code, or with Ctrl, Meta, or Alt held. `⇧V` and `⇧F` need Shift: Caps Lock alone doesn't mark a chapter or go full screen.

### Phone and iPad

- Every control is a 44px target on a touch screen, iPads included; BB's title-bar buttons are 36px inside 44px targets, and resize handles are 12px wide. The gutter's **+** shows only with a mouse or trackpad; on touch, tap a line, then another for a range.
- On an iPad, the layout is the desktop's at touch sizes, and the band stays while the on-screen keyboard is up. Resizing the window (Split View, Stage Manager, turning the iPad) hides a docked panel that no longer fits, and docks it again when there's room; nothing opens over the code by itself. The band fits its room as with a mouse. Where touch leaves little room, the bars make way: beside docked Comments with under 600px of code, the selection and step bars sit at the code's left. On a 13" iPad held upright with BB's thread list collapsed, docked Comments leaves the code that little room.
- On a phone there's no band. A dock at the bottom holds **‹** (All reviews), the chapter you're on, **Comments** (how many aren't submitted, and a dot when something needs you), **Ask agent**, and **Full screen**. The chapter, Comments, and Ask agent switch one sheet above it between the chapters, Comments with Finish review, and the agent; a flick down, ✕, Esc, its tab, or a tap on the code above it closes the sheet. The chapters sheet holds Diff options and Review actions. The dock steps aside while you type or select lines, and toasts sit above it. Menus open as drawers from the bottom. On All reviews, ⌕ in BB's title bar opens the find box.
- A phone held sideways, or any window under 500px tall, has a 40px band and opens the chapters and panels only over the code, with the chapter intro collapsed. When the on-screen keyboard leaves a phone little room, the band, the notices, the file's sticky row, and Comments' Finish bar step aside for the box you type in, which comes into view with its buttons where they fit.
- **iPhone 14 Pro Max and iPhone Duo**, held either way, and the Duo folded or unfolded. Folded, the Duo's outer screen gets the phone layout; unfolded, its inner screen gets the tablet layout, with the chapters and Comments beside the code where they fit: held sideways in Safari, Comments docks at 391px beside 560px of code, and in a home-screen app it opens over the code, right of the fold. Folding, unfolding, or turning either phone keeps the line you were reading, what's open (a docked panel becomes the sheet and back), half-typed text with its cursor, and the focus. Typing keeps the box above the on-screen keyboard, its buttons too, except folded and held sideways, where the Duo has room for the text box alone until the keyboard goes away. In a home-screen app the review keeps clear of the notch, the Duo's side rail, and the home indicator, sideways too. On the Duo's inner screen the band's controls, the selection and step bars, menus, and Comments over the code keep off the fold (a band with under 600px of room in a phone's window ends with **Diff options** alone, which then holds the compare select and **Fold comments in code**); where Safari doesn't report the fold, its place is estimated.

## Whose turn

**All reviews** has four sections, in the order you'll work them. Needs review starts open and the others closed; each remembers what you chose, in this browser.

- **Needs review**: it's your turn. Reviews that came back to you (**Back to you**), new reviews and requests for your review (**New**), and **Team requests**, each longest-waiting first. **Blocks merge** marks a changes-requested review that's the only thing left, since everyone else approved; it comes first. Your own PRs show here as **Your PR** until you've reviewed them, then in Reviewed; they never wait on an author or alert.
- **Waiting on author**: you requested changes, or commented with threads still open, and the author hasn't said they're done. Rows show progress (`2/5 addressed`, `+1 nit`), new commits, CI, outdated threads, and how long the author has been quiet. Snoozed reviews wait here too.
- **Reviewed**: you approved, or commented with every thread resolved or answered. A push after your approval adds “updated” but doesn't bring it back.
- **Archive**: merged, closed, or archived by you; a PR found on GitHub that no longer requests you (**No longer requested**); and one GitHub hasn't found for 7 days (**Can't read on GitHub**).

Each row is two lines: the title, repository and number, and age (in Needs review, how long it's been your turn), then why it's yours and only the facts that change whether to open it, such as the PR's size (`+120 −30 · 8 files`). With a mouse, hovering a row shows **Snooze**, **Pin**, and **Archive**; on touch, every row has its **Review actions** (⋯). The box at the top finds a review, filtering the list by repository, @author, title, or #number, or takes a pasted PR link or `owner/repo#n`: **Open** the review if it's listed, or **Review** it to start one. `/` puts the cursor in the box; on a phone, ⌕ in BB's title bar opens it. The list keeps the box's filter when you come back from a review. **Refresh** and **Settings** sit in BB's title bar; Refresh's tooltip says when GitHub was last read, and the list says why it can't be read now: `gh` not signed in, a rate limit (reading then pauses for 15 minutes), or PRs or teams it can't see. Stacked PRs sit together, bottom first, labeled `Stack · 2 of 3`; a review's Overview links **Stacked on #N** and **#N builds on this**, and says when you haven't reviewed the PR below.

BB's thread list shows **Needs review** too, below Pinned and Threads: the same reviews in the same order, with how long each has waited. It collapses like the other groups, and choosing a review opens it. **Pin** a review, from its row there (with a mouse) or its **Review actions** menu, to put it in BB's Pinned group after your pinned threads; it stays until you unpin it or it moves to Archive, and the list marks it with a pin. BB has no plugin slot for any of this, so Guided Review adds it to BB's list itself; if a BB update changes that list, it may not show until Guided Review catches up. To keep BB's list to threads, turn off **Show reviews in the thread list** in Settings; your pins are kept.

A push alone never makes a review your turn: authors often push one fix at a time. A review comes back to **Needs review** when:

- the author **re-requests** your review (it even leaves your archive); a request to a team you're on isn't a re-request;
- the author **asks you something** on one of your threads, or anyone mentions you on the PR, in a review, or in a line comment and you haven't commented since, whatever your verdict (choose **Any reply** in settings to come back on every reply). Only the author's replies count on your threads; anyone else's counts when it @mentions you;
- every thread you opened is **resolved or answered**, apart from non-blocking ones, there are new commits, CI isn't running or failing, and the author has been quiet for 10 minutes;
- with **After the author pushes → Check, and bring it back** on, the review assistant finds all your feedback addressed;
- GitHub dismisses your review.

Once a review comes back because your feedback was handled, it stays in Needs review until you act, even if the author pushes again. Your verdict is your latest approve or changes-requested review, as GitHub counts it: replying to a thread doesn't change it. If a review came back too early, choose **Snooze → Until the author responds** in its **Review actions** menu, its row, or its Overview. It waits on the author until a newer reason; pushes alone don't wake it. Snooze's other choices, **Later today**, **Tomorrow**, **Monday**, and **Pick a date…**, set aside a review or a new request until then: it waits as "Snoozed until Mon 9:00 AM" and comes back at that time, or sooner for a newer reason. **Back to Needs review** ends a snooze. Snooze, Pin, and Archive can be undone from their toast.

A thread whose first comment starts with `nit:`, `FYI:`, `optional:`, or `non-blocking:` (bold or not) is **non-blocking**. It doesn't keep a review on the author, progress counts it apart (`2/2 handled +1 nit`), and Request what's left leaves it out; a question on it still brings the review back. Comments you submit with the **Nit** severity start that way.

Guided Review alerts only about what happens after it starts following a PR: after an upgrade, or when it first finds PRs on GitHub, the list fills in quietly, except new requests for your review.

**When a review comes back, it's prepared for you.** An out-of-date guide is rebuilt for the new commits, keeping its chapters where the files still fit and summarizing what changed since your review; if the rebuild fails, the previous guide stays. (For a PR found on GitHub, without a guide of its own, this happens only in your auto-start repositories.) Then the review assistant checks your feedback, in the review's own conversation: for each of your threads, and each ask in your review summary, it records whether the author **addressed** it, partly, not at all, or disagreed, with one line of evidence. It also looks for new problems in the fix commits, drafts replies to your threads, and suggests a verdict with a summary, which goes into your draft. Comments shows all of it. The agent's check sits at the top ("Agent’s check · a1b2c3d · 2h · 2 of 3 addressed", with **Check again**), and **Needs you** lists each thread that needs you, non-blocking ones last: your comment, the author's replies, the assistant's verdict and evidence (**Show the fix** opens its line), the drafted reply waiting as an "Agent reply draft · not sent", **Reply**, **Resolve**, and in ⋯ **Follow up** (a new draft comment at the line). Your feedback's progress on the Overview opens it. If you'd already written your own summary, the suggestion waits in **Finish review**: **Use as draft** puts it and its verdict in your draft. **Request what's left** drafts a Request changes listing what's still open. Nothing posts to GitHub until you choose Send reply, Resolve, or Submit. Change the check's instructions, or turn it off, with **Re-review check** in settings.

On a re-review, the compare select in the band says what the diff shows: **All changes**, **Since your review**, or since a commit. **Since your review** shows only what changed since the commit you last reviewed, with new lines marked. It compares the PR's diff then with its diff now, so rebases and merges from the base branch don't show up as changes. Viewed marks survive a rebase, and chapters show how many of their files changed. Its menu lists your last review, then the PR's earlier commits: pick one to see what changed since it ("Since abc1234"). On a PR you haven't reviewed, **Compare with a commit…** in Diff options does the same. Where the band has no room for the select, Diff options holds the comparison, and a narrowed diff says "Showing changes since your review · 1 of 3 files" with **Show all**. A comparison that fails says why. A picked commit lets go when you choose All changes or Show all, open a file the comparison hid, follow a Find result, or the author pushes: the files' Changed badges count from your last review again.

With **Track reviews from GitHub** on (the default), PRs where your review is requested, and open PRs you've reviewed in the last 60 days, join the list without a guide; build one with **Build the guide** on its page or in its menu. Requests to a team you're on join only with **Include team requests**: teams can be asked for many reviews. List patterns under **Start guides automatically** (`acme/*`, `acme/api`, or `*`) to have the guide ready by the time a request alerts you. A PR you delete isn't added back. Reading GitHub costs about 6 GraphQL points per 10 PRs a pass, plus about 2 points to re-read the threads of an active review with an open thread of yours, every 10 minutes, out of the 5,000 an hour your account has.

## Customize your reviews

Open **Settings** from ⚙ in BB's title bar on All reviews, or **Review settings…** in a review's ⋯ menu, or use Guided Review’s section in BB’s plugin settings. Its page goes back where you opened it from: **All reviews** or **Back to review**. Choose Concise, Standard, or Detailed guides, add guide-writing instructions, customize the review assistant’s priorities, set how reviews come back to you under **Whose turn**, and choose who agents run for on their own under **Trust** (see [Data and access](#data-and-access)). Your GitHub account and its switcher are under **Ready to review**. Save settings to apply them across this installation. Restore defaults stages a change for you to save; it does not change settings immediately. The diff's layout is set in a review's Diff options, for every review.

Guide instructions extend the bundled `guided-review-generate` skill. They apply to new guides and to guides you update or rebuild; the output schema and complete file coverage remain validated. Assistant instructions, up to 2,000 characters, reach the assistant as hidden instructions; an idle conversation picks up changes on its next message. **Automatic review** is the assistant's first message when a guide is ready and the review has no conversation yet. By default it asks for a precision-first review: at most 10 comments, each confirmed in the code and labeled with its severity, and a review summary with the verdict it suggests by stated rules. On your own PR it's a self-review that suggests Comment. Settings saved with an earlier default use the new one. Leave it blank to turn the automatic review off.

The assistant learns from what you remove. When you remove a comment it wrote, it's told not to raise it again unless the code changes. Each submitted review records whether you kept, edited, or removed each of its comments, and Settings shows the tally ("Of the agent's last 40 comments you kept 31 as written, edited 6, removed 3") with the comments you removed lately. **Suggest instruction changes** asks the agent for up to five instruction lines from those removed and edited comments; you edit them, add them to Assistant instructions, and nothing applies until you save.

The guide writer and the review assistant each have an **Agent** setting. **Project defaults** runs on the BB server with the provider, model, reasoning effort, and permission mode BB remembers for the review’s project. **Custom** pins all four, plus the service tier where the provider has one, with BB’s pickers, starting from the Personal project’s defaults. Custom also chooses the **Machine**: the BB server or another enrolled machine, such as your laptop. The pickers then list that machine’s providers, models, and permission limit, and the agent runs in its Personal workspace with the agent configuration installed there; within the chosen permission mode, it can reach that machine’s files and credentials. If the machine is offline or removed, building, updating, or rebuilding a guide, `bb review`, and a new assistant conversation fail at once and say why. Guide-writer changes apply to new guides and to guides you update or rebuild. The review assistant’s setting seeds the agent picker for a new conversation; within a conversation, change the model and effort per message as in any BB chat. A conversation keeps its provider and machine; to switch, start a **New conversation**. If BB can’t start a custom agent (for example, its provider was disabled), the assistant shows the error; failed generation records it in the plugin log.

## Comments and Finish review

**Comments** (`c`, or **Comments** in BB's title bar) lists everything said about the change, beside the code, never instead of it: your draft comments and the agent's, everyone's GitHub threads, and your discussions with the agent. Its chips, **All**, **Needs you**, **Not submitted**, and **On GitHub**, show a count each and filter the list; on a touch screen they wrap to a second row where they don't fit. The list is grouped in that order: **Needs you** (a question for you, an author's reply, a thread the agent's check says isn't addressed, an agent reply draft, a comment on an older diff), **Not submitted · only in BB** (counted by severity, "1 blocking · 2 nits"), **On GitHub** (yours first, "Yours: 2 of 2 handled +1 nit", then other people's; resolved and outdated threads folded), and **Private · with the agent**, in reading order within each. Choosing a row shows its comment in the code, switching chapter and unfolding it if needed; its ⌄ opens the whole card in place, which is how file comments, outdated threads, and asks from your review summary read. ↻ reads GitHub again. ⋯ **Comment options** holds **Hide nits** (remembered in this browser, in the code too), **Remove nits**, **Show resolved threads**, **Add comment by line…**, and **Open PR on GitHub**. While you write a comment in the code, the list says where, with **Show in diff**. Comments on a local review stay in BB.

Every comment is the same card in Comments and in the code, and says where it lives, in words as well as looks. Anything only in BB is dashed and says so: "Draft · not submitted", "Agent draft · not submitted" for one an agent wrote, until you edit it, and "Older diff · not submitted". A GitHub thread is solid, headed **On GitHub**, with who wrote each comment and when, who resolved it, and its state: "Waiting on author", "Author replied", "Question for you", "Resolved", "Outdated", or "File comment". A discussion with the agent is muted, with a lock: "Private · with the agent". `]` and `[` step through the list's current chip, across chapters; with Comments closed, a hint says where you are ("2 of 5 · Not submitted"), and on touch, after you open a comment from the list, a step bar does.

Each line comment can have a severity: **Blocking**, **Should fix**, **Question**, or **Nit**. Set it in the comment box, or start the comment with its label, such as `**Blocking:**`; the card shows it, and GitHub gets the label in front of the comment. Removing a comment shows a toast with **Undo**. Changes from the assistant or `bb review comment` appear in Comments and the code as they happen. Agents can also edit and delete comments, and are told to change yours only when you ask. Nothing they do posts to GitHub.

What you write in a reply, on anyone's GitHub thread, waits as a reply draft ("Reply draft · not sent") until **Send reply** posts it, at once, not with your review; **Discard** drops it. **Resolve** posts at once too. A reply or resolve in the code shows in the list at once, and the other way round.

**Finish review** (`s`, **Submit review** in BB's title bar, or the bar at Comments' foot, which says the verdict and how many comments will be sent) holds what goes to GitHub when you submit: the summary, the verdict, and exactly what will be posted.

- **Summary · posted with your verdict:** the comment GitHub shows with your verdict, above the line comments. It works like a line comment. The assistant writes it, labeled "Agent summary · not submitted", and suggests a verdict; only you pick the verdict. **Edit** makes the summary yours, and **Remove** clears it. **Ask agent** opens a discussion with the assistant under the summary: ask why, or say what to change, and the assistant changes the summary there. **Undo** puts back its latest change. The assistant never replaces a summary you wrote unless you ask on it, and then only while it answers that ask, not in work it was already doing. While it works on the summary, Edit waits; if the summary changes while you're editing it, the box says so before you save. When a summary the assistant wrote no longer fits your comments, or the verdict you picked, it says so, with **Update**. With no summary, **Write summary** or **Ask agent to write it**.
- **Verdict:** Approve, Comment, or Request changes, the agent's suggestion marked with a sparkle. "Agent suggests …" shows its suggested summary, or its check's, with **Use as draft** and **Request what's left**. On your own PR only Comment is offered, as GitHub refuses the others.
- **Goes to GitHub:** the comments and their severities, and anything to settle first, each with its fix: comments on an older diff (Submit waits until you edit and save them, or remove them), a Request changes without a summary (it waits for one), a verdict other than the agent's, or an approval with blocking comments. Reply drafts are listed too: they post on their own, with Send reply.
- **Stays in BB:** **Private notes**, only if you have some (see below).
- **Submit to GitHub**, with your verdict on it, pinned at the foot, with where it posts and as whom. It asks once more (**Submit anyway**) when the verdict isn't the one the agent suggested, the agent's summary is out of date, or you approve with blocking comments; otherwise it's one click. It waits while you're writing a comment or the summary. Submit refuses a draft whose comments, summary, or verdict changed since the page last showed them.

After you submit, the panel reads **Review submitted**: the verdict, where it posted and as whom, **View on GitHub**, **Add another review**, and the next review in Needs review, with **Open**. A merged or closed PR's Comments ends with "Merged · Archived" and **Open**: its **Archived review**, with the unsubmitted draft and notes to read.

On your own PR or a local review, **Fix in a new thread**, in Finish review, hands the draft comments you choose to a visible BB thread in the review's project. Its first message lists each comment with its file, lines, severity, and code, and the branch and commit you reviewed. It runs on the review assistant's Agent setting, and is told not to push or change GitHub unless you ask in that thread. The draft isn't changed or submitted.

Reviewer notes are no longer a tool. Notes you wrote before 0.6.0 are under Finish review → Stays in BB → **Private notes**, only when you have some: saved in BB, and never included in GitHub submissions or assistant prompts. Notes survive submission and archival. If saving fails, unsaved notes have a browser recovery copy; conflicting edits can be compared with the saved version before choosing what to keep. Existing review summaries retain their original public-draft meaning, and count as yours.

## Data and access

Review metadata, patches, generated guides, and drafts are stored in this BB installation’s plugin database. Review agents receive the patch and context through your configured BB provider; that provider’s data handling applies. The review assistant runs in the permission mode of its Agent setting, on a machine whose `gh` login can usually write to GitHub. Its instructions forbid GitHub writes, but text in a PR could try to steer it, and the automatic review runs unattended; choose its permission mode with that in mind. This plugin does not add a separate hosted review service.

So agents start on their own (an auto-started guide, the automatic review, the feedback check) only on PRs from the repository's owner, members, and collaborators. Change it under **Settings → Trust → Run agents on their own for PRs from**: members and collaborators (the default), or anyone. Your own PRs and local reviews always run. On another author's PR, the list row and the review say what didn't run and why ("Not run automatically: @x isn’t a member of acme"), and the review offers one click to run it. A run you start lets the automatic review and checks on that commit follow; each new push needs a new click.

**Let the review agent run the repo’s tests and linters**, off by default, lets the review agent run the commands the repository documents, in a temporary git worktree. **This runs the PR's code on the agent's machine**, with that machine's files and credentials in reach. It applies only to your own PRs and PRs from the authors you trust above; a click never allows it for others.

Reviews of PRs merged or closed for 30 days drop their stored diff to save space; the guide, draft, and notes stay, and opening one reads the diff from GitHub again. Open PRs, local reviews, guides for an earlier head, and drafts with comments keep theirs.

GitHub operations use the server’s `gh` credentials. No token needs to be pasted into the plugin. Grant only the repository access your team needs. A shared BB server uses shared server credentials and plugin storage; it is not a multi-tenant review service.

Older saved reviews remain available. New reviews use repository-scoped identifiers, preventing equal PR numbers in different repositories from overwriting each other. Legacy inline drafts must be removed and re-added against the current patch before submission.

## Development

```sh
npm ci
bb plugin types
npm run check
bb plugin install .
bb plugin dev
```

Development checks use the SDK test harness, temporary Git repositories, and mocked GitHub writes. Use a Node.js version compatible with the installed `better-sqlite3` package (this release was verified on Node.js 24).

BB builds the plugin from source when it installs or updates it, so the build output in `dist/` isn't committed. Keep published tags immutable. Read [CHANGELOG.md](CHANGELOG.md) for release changes.

Inspired by [plannotator/guides](https://github.com/plannotator/guides). The viewer and generation workflow here run through BB.

## Review state and archive

Each review’s assistant conversation is a hidden BB thread, shown in the review with BB’s chat. Review context (guide intent, chapters, and your assistant instructions) reaches it as hidden instructions, refreshed when an idle conversation continues after the guide is updated or rebuilt, or the instructions change. Selections and the Ask agent button quote the file or lines into your message. **New conversation** archives the current one; if a conversation’s thread is archived or deleted, the next question starts a new one. Archived PRs can still be discussed: their conversations stay unarchived because BB cannot send to an archived thread. A conversation from an earlier plugin version stays visible above the chat and reaches the first new message as context. Where a submitted review appears depends on whose turn it is; see [Whose turn](#whose-turn). Merged and closed PRs move to Archive automatically; their guides, conversations, and unsent drafts remain accessible. GitHub is checked every one to two minutes for reviews in progress, sooner when GitHub notifies you about a PR, and through Refresh. A failed GitHub read preserves saved state.

To set aside any other review, choose **Archive** from its **Review actions** menu (⋯) in All reviews or the review’s title bar. It stays in Archive, even when new commits arrive, until you choose **Unarchive**, start it again with a PR link or `bb review`, update or rebuild its guide, or the author re-requests your review. **Delete** permanently removes the review’s guide, drafts, private notes, and assistant conversation, including its hidden worker thread, after confirmation; nothing changes on GitHub. Delete is unavailable while a guide is generating or the assistant is answering. A deleted PR isn't added back from GitHub until you start it again.

## Browser regression test

Use Node 24, matching the installed SQLite native module. Build and reload this plugin in an isolated test BB, then run:

```sh
npm install
npx playwright install chromium
bb plugin build
BB_SERVER_URL=http://127.0.0.1:4331 bb plugin reload guided-review
BB_E2E_URL=http://127.0.0.1:4331 npm test -- --project e2e
```

The browser uses the running BB shell and built plugin UI. Guided Review RPC requests are intercepted into the official SDK test host with real temporary SQLite. GitHub and agent calls are stubbed at their external boundaries, so no real PR review or agent thread is created. The flow covers settings persistence, the Overview and Start reading, Comments from BB's title bar and its state across a reload, adding a comment by line and editing it in the code, keyboard tooltips, Finish review's summary, verdict, and private notes, Finish in a 390px phone's Comments sheet above the dock, full screen's verdict and Submit, reload, starting an assistant conversation with file context, Pop out and Dock keeping a half-typed message, All reviews' sections, and merge archival. Without `BB_E2E_URL`, this test is skipped.


## Notifications

With **Needs You 0.2.0-beta.3+** installed, a finished guide appears in your Needs
You inbox with an **Open review** action. Failed generation has its own recovery
message. A review becoming your turn alerts too: re-requested, a request for your
review, a question for you or a mention, or your feedback handled. Each event alerts
once. When Guided Review prepares the re-review first, the alert waits for it (at most
10 minutes) and says how much of your feedback was addressed, for example
`@alice re-requested your review · 4/5 addressed · CI passing · 2 new commits`.
Opening the review, submitting, or snoozing it clears the alert.
Each review has one inbox item; hidden worker threads do not create extra alerts. Enable **Needs You → Settings → Extension activity** to receive
popups, desktop alerts, or optional Telegram pushes through your chosen channels.
Quiet hours apply, and a popup stays quiet while you are already viewing that guide.

Needs You is optional. If it is disabled, missing, or restarting, Guided Review
keeps the guide successful and retries the same completion event once a minute
for up to 24 hours while loaded. Restarting preserves queued outcomes. A newer
generation supersedes the previous queued result; cancelled workers never ping.
