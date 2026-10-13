# Changelog

## 0.6.0 — 2026-10-12

A new review workspace, built so the code owns the screen on a desktop, an iPad, and a phone, with every capability kept but starting new private notes. What gets posted to GitHub doesn't change, and your reviews, drafts, notes, and layout carry over: a review left on Feedback or Threads reopens with Comments open there.

### Layout

- The plugin's top bar and the review's big header are gone, so the code starts right under BB's title bar. On a desktop or an iPad a chapter starts 238px higher, and on a phone 235px higher.
- The review's commands moved into BB's **Guided Review** title bar: **Comments** (its badge counts what needs you), **Ask agent**, **Submit review** with the verdict and how many comments will be sent, **Review actions** (⋯), and **Full screen**. Settings is in ⋯ as **Review settings…**.
- One 44px band over the code says where you are and holds how the code draws: the chapters toggle and **Find in review**, **‹ All reviews**, the chapter with its progress ring, the compare select on a re-review, **Fold comments**, and **Diff options**. In full screen it ends with the review's commands, and toasts, **Undo** among them, show over it where BB shows its own.
- The chapters toggle sits beside Find in review and never moves; `t` shows and hides the chapters.
- The chapters and the side panel dock only while the code keeps 560px; otherwise they slide over it, and Esc, a tap on the code, ✕, or a pick closes them. The diff is never squeezed to 380px again: with Comments open in BB's 1120px pane it's 687px wide, where it was 415.
- The side panel docks narrower, down to 320px, before it covers the code, so it stays beside the code at more widths.
- **Diff options** (⚙) replaces Split view, Wrap lines, Hide whitespace, and the GitHub threads toggle: Layout, Wrap long lines, Hide whitespace changes, GitHub threads in code (now remembered), Collapse all, Expand all, and Keyboard shortcuts. The diff layout moved here from Settings.
- One notice strip under the band replaces the header's banners: new commits say "New commits since this guide was written." with **Update guide**, and **Rebuild guide** is in ⋯.
- ⋯ **Review actions** has one order everywhere: Update or Rebuild guide, Snooze, Pin, Archive, Open on GitHub, Keyboard shortcuts (not on a phone), Review settings…, Delete….
- A guide update that didn't run on its own, for an untrusted author's push, offers **Update guide** (was Re-review), and Submit, refused for new commits, says to update the guide.

### Reading

- A review opens on its **Overview** the first time and whenever it comes back to you: the title, who and what, a status line in All reviews' words, your reviews and the stack, **Start reading** (or **Continue**, or **Review changes** at the first chapter that changed), **Snooze**, then Since your review, What and why, Start here, Requirements, failing checks, and the chapters. Otherwise a review reopens where you left it, now at its scroll position too.
- Mark any chapter viewed, not only the open one: from the chapters list, with `⇧V`, or at the chapter's end with **Mark viewed and continue**. **Undo** puts every file back as it was.
- The chapters list reads **Chapters | All files**, with the Overview first, saying where the review stands, and **Next unviewed** beside the progress bar. On a phone the switch heads the chapters sheet, and the files viewed share the progress bar's row, so the chapters start higher.
- A chapter's intro is one line ("Chapter 1 of 3 · Medium risk · 3 files · 27 lines · 0 of 3 viewed"); on a phone its overview shows three lines until **More**, and **What to verify · 2 ›** is one line that opens the list. Its end says what you've viewed and commented, with **Next: …**, or on the last chapter **Finish review** and the files you haven't viewed yet.
- Only a slim row sticks above each file's code (path, comment count, size, Viewed); the summary, owners, Renamed, Also in, Expand, and Whole file scroll away with the code. A file's count includes its unresolved GitHub threads, and a viewed file that changed again says "Changed since you viewed it".
- A re-review opens on what changed since your review, however you get to a chapter. **Settings → Re-reviews** can open it on **All changes** instead. Review changes still goes to the first chapter that changed.
- A switch in each chapter's intro flips between **Since your review** and **All changes** in one tap, on every device, and keeps the count ("Since your review · 1 of 3 files"). It replaces the phone's "Showing changes since your review" note with Show all. A chapter with nothing new says "Nothing changed in this chapter since your review".
- One compare select says what the diff shows: **All changes**, **Since your review**, or since a commit. Where the band has no room for it, Diff options has it. A comparison that fails says why.
- What you choose holds for the review in this browser until the author pushes and its guide updates, across chapters, leaving and coming back, and BB's layout switches. A picked commit is now remembered too. After a push, the review opens on your Settings choice again, from your last review, so the select and the files' badges agree. Opening a file or a line the comparison hides, from the chapters, a comment, or a Find result, shows all changes, and that holds too.

### Comments

- **Comments** replaces Draft review, Feedback, and Threads: one list beside the code, never instead of it, with **All**, **Needs you**, **Not submitted**, and **On GitHub**, grouped in that order, then your private discussions with the agent.
- Each comment is one card, the same in the code and in the list, and says where it lives: dashed and "not submitted" while it's only in BB, solid with its author on GitHub, muted with a lock when it's private with the agent. "Added by agent" now reads "Agent draft · not submitted".
- Every comment in the code has all its actions, so a whole re-review can happen in the code. Choosing a row in the list shows its comment there, switching chapter if needed; ⌄ opens it in place.
- **Fold comments** (`i`, or the band's button) shrinks every comment in the code to a one-line marker, with **Show** to open one. Phones start folded.
- The agent's check of your feedback sits at the top of Comments, with **Check again**, and **Needs you** lists what's waiting on you: a question, an author's reply, a thread the check says isn't addressed, an agent reply draft, a comment on an older diff.
- ⋯ **Comment options**: Hide nits, Remove nits (with Undo), Show resolved threads, Add comment by line…, and Open PR on GitHub.
- A reply you write, on anyone's thread, waits as a "Reply draft · not sent" until **Send reply** posts it. GitHub threads show who wrote each comment and when, who resolved the thread, file comments, and bots.
- `]` and `[` step through the list's current chip, across chapters; with the list closed, a hint says "2 of 5 · Not submitted", and on touch a step bar follows a comment you opened from the list.
- **Finish review** (`s`, Submit review, or the bar at Comments' foot) gathers the summary, the verdict with the agent's suggestion (**Use as draft** and **Request what's left** moved here from Feedback), exactly what goes to GitHub, with anything to settle first and its fix, and what stays in BB. **Fix in a new thread** moved here too.
- After you submit, the panel reads **Review submitted**, with where it posted, **View on GitHub**, and the next review in Needs review.
- Reviewer notes are no longer a tool. Notes you have are under Finish review → Stays in BB → **Private notes**, still never sent.
- A merged or closed PR's Comments ends with "Merged · Archived" and **Open**, its archived review with the unsubmitted draft and notes.
- When a review comes back to you and Comments can't open beside the code in BB's pane, a "3 need you" pill offers it until you scroll or start a comment.

### Phone and iPad

- A phone has no band: a dock at the bottom holds All reviews, the chapter you're on, Comments (with its count, and a dot when something needs you), Ask agent, and Full screen, and one sheet above it holds the chapters, Comments and Finish review, or the agent. On a 390×844 phone the first line of code sits 219px higher.
- The dock steps aside while you type or select lines, and toasts sit above it.
- Every control is a 44px target on a touch screen, iPads included; BB's title-bar buttons are 36px inside 44px targets.
- On a touch screen Comments' chips wrap to a second row where they don't fit, in the iPad's 400px panel too, rather than scrolling out of sight.
- On an iPad or phone, tap a line to select it and tap another for a range; the gutter's + shows only with a mouse. Text selected in the code by any means, a long-press included, offers **Ask agent about selection**. The selection bar's **Add comment** is now **Comment**.
- iPhone 14 Pro Max and iPhone Duo, held either way, and the Duo folded or unfolded: folding, unfolding, or turning keeps the line you were reading, what's open (a docked panel becomes the sheet and back), half-typed text with its cursor, Find's text, the lines selected, and the focus. That holds in BB too, which mounts the review anew as its own layout switches at a 768px window.
- The unfolded Duo held sideways beside BB's thread list (631px) gets the tablet layout: the phone layout is for panes under 600px wide.
- On the unfolded iPhone Duo held sideways in Safari, Comments docks beside the code at 391px instead of covering it.
- Typing keeps the box above the on-screen keyboard, its buttons too wherever they fit; when the keyboard leaves a phone little room, the band, the file's sticky row, and Comments' Finish bar step aside. Where it leaves room for the text box alone (the Duo folded and held sideways, and in BB folded or in Split View), the whole box comes into view once the keyboard goes away. Where BB shrinks its pane above the keyboard, a phone stays a phone while you type and as the keyboard goes. An iPad keeps its band.
- In a home-screen app the review, its dock, sheets, and menus keep clear of the notch, the Duo's side rail, and the home indicator, sideways too.
- On the Duo's inner screen, the band's controls, the selection and step bars, menus, and Comments over the code keep off the fold. Safari doesn't report the fold by default, so its place is estimated there.
- Menus, Diff options, and Snooze open as drawers from the bottom on a phone, and on one held sideways.
- On a desktop or an iPad, resizing the window (Split View, Stage Manager, turning the iPad) hides a docked panel that no longer fits and docks it again when there's room; nothing opens over the code by itself.
- Double-click or double-tap a resize handle to put back its default width.

### All reviews and Settings

- One box finds a review or takes a pasted PR link or `owner/repo#n`: **Open** it if it's listed, **Review** it if not. `/` puts the cursor there; on a phone ⌕ in BB's title bar opens it.
- Sections replace the tabs: **Needs review** (Back to you, New, Team requests; Blocks merge first), **Waiting on author**, **Reviewed**, and **Archive**, each remembering whether it's open.
- Rows are two compact lines: the title, repository and age, then why it's yours and only the facts that change whether to open it. A 390×844 phone shows 11 rows where it showed 4. With a mouse, hovering a row shows Snooze, Pin, and Archive; on touch every row has ⋯.
- **Snooze** is one menu: **Until the author responds** (was Not yet), **Later today**, **Tomorrow**, **Monday**, and **Pick a date…**. Snooze, Pin, and Archive can be undone from their toast.
- Refresh and Settings moved to BB's title bar; Refresh's tooltip says when GitHub was last read. With no reviews, a first-run panel checks your setup and says how to start.
- A PR found on GitHub, a guide being built, and a failed guide have a page bar with All reviews and the review's menu. **Start review** is now **Build the guide**.
- Settings goes back where you opened it from (**All reviews** or **Back to review**), and the GitHub account switcher is under Ready to review.
- **Re-reviews** in Settings chooses what a re-review opens on: **Changes since your review** (the default) or **All changes**.
- In BB's thread list, pin buttons show on hover with a mouse, so touch screens keep the rows clear (pin from ⋯), and a row's tooltip says why it's yours.

### Keys and accessibility

- New keys: `t` chapters, `c` Comments, `i` fold comments, `⇧V` mark the chapter viewed, `⇧F` full screen, and Esc closes what's over the code. `s` opens Finish review. `?` lists them all, in Move, Mark, Panels, and View.
- `⇧V` and `⇧F` need Shift: Caps Lock alone doesn't mark a chapter or go full screen.
- Closing a panel, overlay, or sheet gives the focus back to what opened it, and going back from Finish review to Comments puts it on the list. Focus opens a tooltip only from the keyboard, so a tap or a click doesn't leave one showing. The review's keys work while the focus is on its commands in BB's title bar.
- Screen readers hear counts in words ("Comments, 5 not submitted, 3 need you"), Pop out and Dock by the names they show, and Snooze times as "Tomorrow, 9:00 AM". Show or Hide chapters and Full screen say their state in their names, not as pressed toggles.

## 0.5.2 — 2026-10-11

- Collapse a review's header from the chevron at its top-right, and expand it from the same spot. It replaces Focus in the diff toolbar. On a phone, reviews you opened before 0.5.0 now start collapsed too; they had kept the full header.
- The chapters toggle moved from the diff toolbar to the top bar, beside All reviews. On a phone the toolbar is a row shorter.
- **Full screen** works on an iPhone, which can't make a page full screen: the review covers the window, BB's bars included, until you exit.
- On a phone, a review's full header puts Not yet, Snooze, and Re-review on their own row instead of running them off the screen.
- On a phone held sideways, the top bar shows more of the review's title: All reviews keeps to its arrow there.

## 0.5.1 — 2026-10-11

- **Needs review** in BB's thread list: the reviews waiting on you, below Pinned and Threads, collapsible like them. Choosing one opens it, and closes the sidebar on a phone.
- **Pin** a review, from that list or its Review actions menu, to keep it in BB's Pinned group after your pinned threads, until you unpin it or it's archived.
- **Settings → BB's thread list → Show reviews in the thread list** turns both off, for a BB update that breaks them or a list you'd rather keep to threads. It's on by default.
- The review list scrolls in BB, on a phone and in a short window, instead of stopping at the window's edge. So does a tracked PR's page.
- On a phone, the chapter list no longer draws over Draft review when both are open: it scrolls in the room above, and the toolbar row with Chapters stays.

## 0.5.0 — 2026-10-11

Reload Guided Review pages left open across the update: until then they can't save. Events from before the update don't alert or start agents under the new whose-turn rules.

### Reviewing the diff

- Each chapter opens on an intro with its overview, and medium- and high-risk chapters list **What to verify**. The end of a chapter offers the next one, and a review reopens on the chapter you were reading.
- **Requirements: 3/4 covered** checks the PR against what its description and linked tickets ask for, with evidence and a link to each line.
- **Start here** points at the guide's riskiest lines. The header shows the changed lines with a rough reading time; each chapter shows its own.
- Guides can split a file that mixes unrelated changes across chapters, each showing only its hunks, with an "Also in" note. Files the guide leaves out go in a last **Other files** chapter.
- **All files** shows every changed file as a folder tree with a filter, and **Find in review** searches every diff line and the guide.
- The Since menu compares from any of the PR's commits, also on PRs you haven't reviewed.
- Each file header shows its CODEOWNERS owners, from the PR's base branch, and marks the files that are **yours**.
- **Split view**, **Wrap lines**, and **Hide whitespace** toggles in the diff toolbar. The diff goes unified below 960px of pane width.
- **Expand** around a file's changes, or show the **Whole file**.
- Everyone's GitHub review threads show under their lines, with Reply and Resolve; CI failures show on the lines they're about.
- Lockfiles, generated files (also by `.gitattributes`), test snapshots, and huge diffs start folded. Viewed files fold at once.
- Keyboard shortcuts: `j`/`k` files, `n`/`p` chapters, `v` viewed, `u` next unviewed, `]`/`[` comments, `/` find, `f` all files, `a` ask, `s` submit, `?` for the list.
- Renamed files, odd file names, `--`/`++` lines, PRs over GitHub's diff limit, and personal git diff settings no longer break the diff or line numbers.

### Comments and severity

- Comment on a range of lines ("Lines 10–15"), posted to GitHub as a multi-line comment. **Suggest change** inserts a suggestion block.
- Draft comments have a severity (**Blocking**, **Should fix**, **Question**, **Nit**), posted as the comment's label. Draft review counts them, with **Hide nits** and **Remove nits**.
- Submit asks once more when you go against the agent's verdict, its summary is out of date, or you approve with blocking comments; it waits on comments marked Older diff and names them.
- On your own PR only Comment is offered. **Fix in a new thread** hands chosen comments on your own PR or a local review to a BB coding thread.
- **Undo** after removing a comment; Cmd/Ctrl+Enter saves and Esc cancels; the receipt links to the review on GitHub; comments list in the guide's order.
- `bb review comment` takes ranges (`path:10-15`) and `--severity`.

### The assistant

- The automatic review is precision-first: at most 10 verified comments, labeled by severity, and a verdict by stated rules. On your own PR it's a self-review.
- The assistant reads the PR's description, linked issues, commits, failing CI, others' threads, the repo's AGENTS.md, CLAUDE.md, and Copilot instructions, and which files you own, and treats all PR text as untrusted.
- It can read files before the change and in local reviews, and re-checks its draft comments when new commits arrive.
- It won't raise a comment you removed again unless the code changed. Settings shows how its comments fared, and **Suggest instruction changes** proposes instruction lines from them.
- Agents can't change comments you wrote unless you ask on them, and you can Undo what they change.

### Whose turn and the list

- Threads starting with `nit:`, `FYI:`, `optional:`, or `non-blocking:` don't hold a review on the author; progress shows them apart (`2/2 handled +1 nit`).
- **Snooze until** later today, tomorrow morning, next Monday, or a date.
- Stacked PRs sit together in the list, bottom first, and link to each other.
- **Your PR** for your own PRs; **No longer requested** and **Can't read on GitHub** move PRs to Archive.
- Only the author's replies, or an @mention of you, bring a review back. Team requests after your review no longer count as re-requests. Mentions in reviews and line comments count.
- **Find a review** in the list; rows show PR size, outdated threads, and a quiet author. The list says when GitHub was last read and why it can't be.
- Checks that never report stop holding a review back after an hour.

### Trust and safety

- Agents start on their own only on PRs from members and collaborators (**Settings → Trust**). Other PRs say what didn't run and why, with one click to run it.
- Opt-in: **Let the review agent run the repo’s tests and linters** on trusted authors' PRs, in a temporary worktree.
- A PR's own `.gitattributes` and instruction-file globs can't stall the plugin, and failing CI check names reach agents marked as PR text.

### Phones and speed

- On phones the workspace has a one-row top bar and a compact toolbar, a short screen opens on the code, and list rows put the status under the title.
- Large chapters draw files as they near the screen: a 300-file chapter shows code in under a second.
- Saving a comment no longer re-reads the whole diff, an open review reloads without resending it, and merged or closed PRs' stored diffs are dropped after 30 days.

### Fixes

- Comments on neighbouring lines stay on their lines after a re-review, and comments, discussions, and Viewed marks follow renamed files.
- "Waiting for agent" and unfinished feedback checks clear after a reload or a lost conversation; a guide interrupted by a reload restarts.
- A guide whose worker fails ends at once; big PRs get longer to generate.
- A `gh` account switch made in a terminal is noticed within a minute, and a rate limit pauses reading for 15 minutes.

## 0.4.0 — 2026-10-10

- The review summary works like a draft comment. It sits at the top of **Draft review** (formerly Draft comments): the review assistant writes it, labeled **Added by agent**, with the verdict it suggests marked on the verdict buttons; **Edit** makes it yours; **Ask agent** discusses it with the assistant under it, and the assistant changes it there. Only you pick the verdict.
- The assistant never replaces a summary you wrote unless you ask on it, and only in the turn that answers you. A summary it wrote before your comments or verdict changed says so, with **Update**. Submit refuses a summary or verdict that changed since the page showed it, as it does comments.
- **Undo** puts back the assistant's latest change in a discussion: a summary, or a line comment it edited, removed, or added.
- The verdict and **Submit to GitHub** stay pinned to the foot of Draft review; Request changes waits for a summary. **Submit review** in the review's top bar opens it, showing what you'd submit.
- The re-review check's suggested summary goes straight into your draft. **Use as draft** remains for when you wrote your own.
- New `bb review summary` shows or writes a review's summary, like `bb review comment`.
- The automatic review now writes the summary instead of putting general points in the chat. Settings that kept the old default prompt get the new one; custom prompts are untouched.
- The Ask agent tool has a chat-with-sparkle icon instead of a question mark.

## 0.3.0 — 2026-10-10

- Track whose turn each review is. New **Waiting on author** list; a push alone no longer brings a changes-requested review back. Re-requests, questions or mentions, handled feedback, and (opt-in) the assistant's all-addressed check do. **Not yet** waits for a newer reason. Approvals no longer bounce on pushes. A re-request takes a review out of your archive.
- Keep your verdict when you reply to a review thread. GitHub records replies as reviews; they turned "Changes requested" into "Commented" and could drop the PR from Needs review.
- Needs You alerts when a review becomes your turn, once per event, after its re-review is prepared, with your feedback's progress, CI, and new commits; opening or acting on the review clears it.
- Prepare re-reviews automatically: rebuild an out-of-date guide (keeping its chapters, with a since-your-review summary), then the review assistant checks each piece of your feedback and records addressed, partial, not addressed, disputed, or unclear, with evidence; drafts thread replies; and suggests a verdict. New **Feedback** view with Resolve, Reply, Follow up, Use as draft, and Request what's left.
- **Since your review** narrows the diff to what changed since your last review, robust to rebases and base merges. Viewed marks survive rebases. Unsent draft comments follow their lines into a new diff.
- Track PRs you're asked to review or have reviewed on GitHub, start guides automatically for chosen repositories, and mark the review that's blocking a merge. Batched GitHub reads cost about a fifth of the previous per-review polling.

## 0.2.1 — 2026-09-09

- Notify through Needs You when a guide is ready or generation fails, with a direct link to the review.
- Durable, bounded retries when Needs You is missing, outdated, disabled, or restarting.
- Keep completed generation identities across reloads; suppress stale and cancelled outcomes.
- Explain notification setup in Review settings.

## 0.2.0 — 2026-09-09

- Added setup readiness, installed-version reporting, manual update checks, release links, and optional automatic updates through BB. Automatic updates default off and wait until all review pages close and review work is idle. Saved data stays in BB.
- Added configurable guide depth, guide and assistant instructions, default diff layout, and separate private reviewer notes with conflict recovery.
- Refined the responsive workspace, collapsible tool rail, fullscreen menus, and detachable assistant.
- Kept submitted verdicts visible and archived merged or closed PRs without deleting their guides, drafts, notes, or conversations.
- Bound saves and submissions to the revision displayed in the browser, and bound submission credentials to the displayed GitHub account.
- Refreshed assistant context after re-review and stopped its worker when the plugin is disposed.


## 0.1.0 — 2026-09-08

First packaged team preview. Requires BB 0.41.0 and plugin SDK 0.4.34.

- Added first-run guidance, clear account scope, recoverable loading errors, and full-width responsive review layouts.
- Saved notes on blur and before submission, exposed save failures, prevented repeated submission, and preserved edits made while submission is in progress.
- Scoped review identifiers by repository or workspace; retained access to older saved reviews.
- Verified PR snapshots and commit-pinned reviews; rejected comments from stale patches and results from superseded generation workers.
- Added generation cancellation and restart recovery, safe local-ref handling, account-switch verification, and CI failure/pending handling.
- Included installable bundles and documented team repository access, server-local Git/GitHub CLI requirements, and data handling.
