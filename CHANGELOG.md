# Changelog

## 0.8.1 — 2026-10-16

Fixes only. An agent in one of your threads can no longer start the review's agents on an untrusted author's PR, and the agents a review has replaced can no longer touch another review; the palette's next-review key no longer reloads BB; a guide waiting for its writer's machine says so rather than that it failed; and a lockfile in any format that holds URLs names a new download host. Nothing new to turn on or off, and every switch means what it did. Guided Review still needs **BB 0.45+** (plugin SDK **0.6.14+**) with Node 24+, and installs at `^0.8.0`, which updates to 0.8.1.

### Agents and trust

- An assistant that New conversation replaced or found archived, an earlier guide writer (one a reload interrupted, or replaced while it started, included), the agent thread a chat replaced, and a deleted review's thread that couldn't be stopped or deleted are kept to their own review in `bb review`, `bb review comment`, and `bb review summary`, and can't list reviews; the Suggest instruction changes worker can't use them on any review. Before, each could write any review's draft and start a review that counted as your click.
- `bb review` on a PR from one of your BB threads counts as your click only for an author agents run for on their own. For anyone else, or when GitHub can't say, it builds the guide and leaves the run to your click. With **Run agents on their own for PRs from** set to anyone, GitHub isn't asked.
- A new PR's guide writer judges its author from the PR it just read, so the first guide of a member's or your own PR is no longer told its author isn't trusted, and reads its linked tickets.
- The automatic review no longer starts on a PR already merged or closed, where it couldn't add a draft. Such a review is still read from GitHub once, so it archives and knows your earlier review.
- Lockfile stubs on the agents' pages, and a lockfile's Downloads from chip, name a new download host in every lockfile format but go.sum, which holds no URLs, not only npm's, Yarn 1's, and pnpm's, apart from each format's public registries; github.com counts as one for composer and Swift packages. A host written before `\@`, or a registry path that climbs out with `..`, is named too. A lockfile with a very long line no longer holds up the plugin's server for seconds.
- The agents' file list says a copied file is "copied from" its source, and quotes a path holding a newline, so a PR's file names can't add rows to it.
- read_pr_context tells the agents that a local review's instructions are read where its diff starts.

### Fixes

- **Next review that needs me** defaults to ⌘⇧U (Ctrl+Shift+U), since BB force-reloads on ⌘⇧R, and on the web takes it from the browser's hard reload. A key you set in BB stays yours.
- **Review PR from clipboard** names the PR it started ("Started a review of acme/web#7: Fix cache keys"), with **Open**, rather than opening it unasked.
- A comment edited after you sent it to a thread no longer says "Sent to ‹thread›", and one sent under a minute ago says "· 1m" from 45 seconds, not "· 0m".
- **Send 2 comments to ‹thread›** spaces the thread's title by a word space, not twice that.
- **Open in editor** shows only on a local review whose diff ends at the checkout (a ref, or a range ending at `HEAD`), so it no longer opens a file from another version.
- A failed guide update says why under its notice, in up to 3 lines.
- A guide waiting for its writer's machine to reconnect says so on its page, in its update notice, and in its status line, with Try again, rather than that it failed; once its 10 minutes are up, it reads as failed at once.
- `r` on a GitHub thread opens its reply box even when its card in the code shows after the key, as when `]` turns GitHub threads in code back on.
- **Suggest change** fences its lines with more backticks than they hold, and a Suggested change opened with four or more backticks shows in its box, a fence among its lines included.
- The Comments chips' focus ring shows whole, and the Overview's chapter summaries keep to 2 lines.
- Finish review's "Read 6 of 8 files" counts only a local review's reads of its current diff.
- Refreshing your threads from a review tells your other open review pages only when they changed.
- All reviews says "Couldn't", not "Could not", when bb can't name a project to start a review in.

### Installing

- Install and update at `^0.8.0`. No new settings, and nothing stored that 0.8.0 or 0.7.0 can't read.
- After a rollback to 0.8.0, a replaced review agent is an ordinary thread to `bb review` again, a comment edited since you sent it says it was sent, and ⌘⇧R is the default again.

## 0.8.0 — 2026-10-16

Comments go back to the thread that made the change, the agent says which problems the PR didn't introduce and what it didn't read, and comments can be triaged from the keyboard. Agents read the repo's rules from the PR's base, never its head, and are held to their own review; the keyboard, screen readers, and a busy or flaky connection work better throughout. Every new feature has a switch that starts on, 16 in all, and turning one off puts back what 0.7.0 did. Guided Review still needs **BB 0.45+** (plugin SDK **0.6.14+**) with Node 24+, and installs at `^0.8.0`. Rolling back to 0.7.0 keeps your reviews, drafts, and settings, these switches included, which come back with the next update; a custom agent at a reasoning level 0.7.0 doesn't know reverts to Project defaults if 0.7.0 saves settings.

### Settings

- 16 new switches, each on by default and saying what stays when it's off, and a new Settings section, **Guide generation**, for the switch there. Review assistant is now **Review agent**, as the review's panel calls it.
- **Guide generation:** **Stop a guide while it builds**.
- **Review agent:** **Help agents in your threads use bb review**, **Read REVIEW.md**, **Ask why you remove an agent's comment**, and **Dig deeper on a chapter**.
- **Reading:** **Comment keys** (under Single-key shortcuts), **Flag weakened tests**, **Summarize lockfile changes**, **Commands in BB's command palette**, **Notice when a local review's code changes**, **Open in editor (local reviews)**, and **Comment on or ask about a failing check**.
- **Comments and Finish review:** **Send comments to the thread that made the change**, **Move comments on an older diff into the summary**, **Keep pre-existing problems apart**, and **Show what the agent checked**.
- When settings are slow or can't load, a review uses the switches this browser last loaded, not the defaults; a browser that never loaded them still uses the defaults.
- Settings says when an agent's provider runs only at Full, as pi does, so it can't be restricted, and which providers run at Accept Edits. **Custom** starts the guide writer at Accept Edits, else Auto, else the provider's only mode.
- An agent can be saved with any reasoning level its provider offers.
- Trust warns while **Anyone** and running the repo's tests and linters are both on, since that runs any GitHub user's code on the server.

### Back to the thread that made the change

- `bb review` remembers the thread it ran in. Finish review on your own PR or a local review then offers **Send N comments to ‹thread›**, beside Fix in a new thread: on your click it queues them in that thread, asking it to reply with what it changed, and each comment you sent says "Sent to ‹thread› · 2m". Nothing goes to GitHub.
- A local review runs its diff again when you open it, and says "The code changed since this guide." with **Update guide** when it has.
- On a local review, a file's row and a draft's ⋯ offer **Open in editor** at the line.
- `bb review` prints a link to the review, `bb review list [--json]` lists your reviews with whose turn it is, and agents in your other threads get a `guided-review` skill for `bb review` that tells them never to post to GitHub and to treat what it prints as data.

### What the agent found and checked

- The agent marks a problem in code the PR didn't change as **Pre-existing**. It doesn't count as blocking against Approve, is counted apart, and posts, or goes to a coding thread, with "**Pre-existing:**" in front. Mark as pre-existing and Mark as from this PR change it; `bb review comment add` and `edit` take `--pre-existing`.
- Finish review says how many of the changed files the agent read ("Read 6 of 8 files") and folds what it says it didn't check. When it suggests Approve without reading every file, Goes to GitHub says so and Submit asks once more.
- A test file whose diff removes assertions or skips tests gets a chip ("3 assertions removed · 1 test skipped"), and the agents are asked to check it.
- A lockfile shows the packages it adds and removes ("+3 −1 packages"), and warns when one downloads from a host other than its registry; the agents get the same summary.
- **Dig deeper** on a medium- or high-risk chapter asks the review agent for a closer pass over it at high effort, with at most 5 comments.
- The agents read the repo's REVIEW.md, at the root and above the changed files, from the PR's base, and the Overview says when a PR changes a file the agents read.

### Comments

- With **Comment keys**, on the comment `]` or `[` landed on: `e` edits it, `x` removes it with Undo, `1`–`4` set Blocking, Should fix, Question, or Nit, `0` clears it, and `r` replies to a GitHub thread.
- **Why?** on Comment removed, for an agent's comment, takes a reason (Wrong, Intended, Already known, Not worth it) and an optional note. The agent and Suggest instruction changes learn from it, and Settings splits removals by reason.
- A comment on an older diff can **Move to summary**, from Finish review, whose row names it, or its card: it becomes a line of your summary and the comment goes, with no Undo.
- A failing check's note in the code offers **Comment**, a Blocking comment quoting it, and **Ask agent**; the Overview's failing GitHub Actions checks offer Ask agent with the end of the check's log quoted, unsent.

### Commands and guides

- BB's command palette lists **Next review that needs me** (⌘⇧R by default, unless BB already uses it), **Review PR from clipboard**, and **All reviews**.
- **Stop** on the building screen or a guide update's notice stops the guide writer: an update goes back to the guide you had, and a first guide waits for Build the guide.
- A failed guide says why under What went wrong, after its writer is reminded once; the plugin log keeps it too. Review not found leads with Back to your reviews.
- A guide is ready as soon as it's accepted, not when the guide writer's turn ends.
- A guide a reload interrupted restarts once its writer's machine reconnects, for up to 10 minutes.

### Agents and trust

- The agents read the repo's instructions (AGENTS.md, CLAUDE.md, Copilot's) from the PR's base, and are told when the PR changes them; before, a PR could rewrite the rules its own reviewers follow.
- Which files are generated comes from `.gitattributes` at the PR's merge base, and a file the PR adds is read as code whatever its path, so a PR can no longer fold or stub its own code.
- An outside author's edit to the PR's title or description after your click needs another click. A click from 0.7.0 on a PR edited since needs one more.
- A review's assistant and guide writer get their tools by the role recorded for them, not their thread's title, and can't use `bb review` on another review.
- Replies, resolves, and unresolves post as the GitHub account the review verified, and only on its own PR's threads; a page open from 0.7.0 is asked to reload.
- Submit refuses a page that doesn't send the comments, summary, and verdict it shows.
- The agents follow ticket references only in a trusted author's PR, and only read tickets. Commit headlines, the earlier guide's chapters, CI output, and your removal notes reach them fenced as untrusted text. What they write for GitHub, and `bb review --body`, is capped at 65,000 characters, and a feedback check keeps a file:line only when it names a line in the diff.
- In GitHub comments, the guide, CI annotations, the agents' words, and the review summary, images, named by their alt text, and videos show as links; HTML comments stay hidden, as on GitHub; and other HTML shows as text, but for a few tags that only format (such as `details`, `summary`, `p`, `b`, lists, and tables). Code spans and fenced code, in table cells too, show as written where the plugin can tell they're code; where it can't, as inside an HTML block, a `<` in the code shows as `&lt;`. Since Move to summary can put an agent's words in your summary, its card shows your own images as links too; GitHub gets the summary as written.
- The account menu says switching accounts switches `gh` for the whole BB server. After a switch, each review starts afresh for the new account.
- Deleting a review deletes its guide-writer threads too.

### Guides

- The guide writer reads a big diff in 80 KB pages, with lockfiles and generated and vendored files as one-line stubs; `vendor/`, `third_party/`, `Pods/`, and protoc and Dart generated files count as generated.
- It's told when GitHub's 3,000-file list may have cut a huge PR short, and which files GitHub sent no diff for.
- Every chapter has a risk, and every risky one a focus; the riskiest chapters come first, one low-risk chapter ends the guide, and no "Other files" chapter feeds back into a rebuild.
- Start here and Requirements can point at a removed line, opening it on the diff's old side.
- generate_review_guide's description lists every rule it checks.

### Fixes

- Submit never posts a review twice when GitHub's answer is lost or slow: it finds the review it posted and finishes with it. A pending review started on github.com gets a message saying to submit or discard it there.
- An edit box no longer overwrites a comment changed while you edited it: it says what changed, and Save reads Replace comment. A draft saved or removed in one window shows in the review's other windows.
- A comment box on a hunk Since your review hides moves to Comments, with **Show in diff**.
- BB's layout switch at 768px no longer blanks a review's draft status and comments, and no longer downloads the diff again.
- Enter and Esc that end an IME conversion only end it, in Find, the file filter, the agent, and comment boxes.
- Deleting a review forgets where you left it and its agent dock.
- An open review reloads when the connection comes back, and says "Reconnecting…" meanwhile.
- One file's diff that fails to draw shows in its card, rather than losing the whole review.
- Picking a file in a large chapter jumps to it, rather than scrolling past every file.
- The chapters keep the current file's row in view, and tell same-named files apart.
- A narrow pane no longer flashes a split diff first.
- Two quick layout toggles both stick.
- Ask agent with the agent popped out asks in its widget.
- Starting a review again for new commits keeps when it was created.
- A push check that can't start is tried again every 10 minutes, not every minute, and none starts with Run the re-review check off. A feedback check's wait ends only after the check itself has run.
- Up to 1,000 of a PR's review threads are read for your feedback, up from 300.
- Viewed is re-checked on files GitHub sent no diff for when they change, and they're no longer fetched as text.
- A run skipped while Start agents on their own was off says so once it's back on.
- Old diffs are dropped on a daily schedule BB keeps, not on every reload.
- The thread list's Needs review no longer lists reviews while it's turned off, and a closed tab releases its review on an install under another plugin id too.
- Errors say "Couldn't", not "Could not".
- A suggested change from GitHub written with Windows line endings, or ended by an indented or longer fence, shows in its Suggested change box as GitHub would apply it.

### Keyboard and screen readers

- Keys work in the chapters or a panel open over the code, with Caps Lock (Caps Lock V marks the file; only Shift gives ⇧V), and `]` and `[` with AltGr or Option; holding a key repeats only `j` and `k`.
- `d` flips a re-review between Since your review and All changes; `j` on the Overview starts the first chapter; Esc also clears the lines selected.
- `j`, `k`, `v`, `]`, and `[` move the focus to the file or comment they go to, and Next at a chapter's end to the next chapter's title. **Skip to code** comes first.
- Added and removed lines are marked + and −, not by color alone.
- The title bar's submit command is **Finish review**, as its panel and key are, and the phone dock says "2 to send". Finish review's Submit says "Submit to GitHub · Approve · 1 blocking", and Submitting… while it posts; its suggested verdict is said once, with Switch to it.
- Screen readers hear the review commands' keys, each file's card by its path, "Expand chapter 3", "fix-race into main", why a Needs review row is yours, how many rows each All reviews section holds, and new notices.
- A 2px focus ring around the plugin's buttons; Refresh, Refresh comments, and Save settings keep the focus while busy, and Discard edits leaves it on Save settings; New conversation's confirmation takes the focus and Esc cancels it; the popped-out agent moves with the arrow keys.
- Drawers open in place under reduced motion, and each popover menu is named on a desktop.
- Copy: "New since your review" on a new file; "Large diff · 1,600 lines"; reading times in days past 24 hours; "your last review, just now"; "Checking setup…"; Resolve says it posts to GitHub now; Comments' empty state says how to comment with a mouse or the keyboard.

### Faster

- Opening a review splits its patch once, not nine times, and reads a file's lines only when a comment box opens on it.
- Viewed hashes only the files you marked, once per diff.
- A guide rebuild parses each diff once, not once per draft comment.
- The plugin starts without reading the diff of reviews that have no discussions.
- Moving from file to file, and a Viewed refresh that changes nothing, no longer redraw the review.
- Open review pages re-read your threads only when they changed.

### Installing

- Install and update at `^0.8.0`. A Git range follows only its compatible releases, so an install at `^0.7.0` stays on 0.7.x.
- Installing no longer pulls Hugeicons' packages, about 146 MB per kept version: the plugin draws its icons from its own copy.
- Idle review assistants restart once after the upgrade, keeping their conversations, so they learn the new tools.
- The plugin builds, tests, and typechecks against the SDK BB runs (0.6.49), and a backend test that runs the real `gh` fails.
- After a rollback to 0.7.0, a PR rename alone no longer asks for another click, removed-line hotspots open as new-file lines, and a failed guide doesn't say why.

## 0.7.0 — 2026-10-14

Settings can now turn off what you don't use, Finish review checks an approval against what you read, and the agent shows how it checked each comment. Every setting starts on, so nothing changes until you change it. Agents are held tighter to their own review, and several ways to lose your place or your words are fixed. Guided Review now needs **BB 0.45+** (plugin SDK **0.6.14+**) with Node 24+; BB older than 0.45 won't install it. Rolling back to 0.6.0 keeps your reviews and settings, and the new switches come back with the next update.

### Settings

- 18 switches turn features off, each saying what stays when it's off, in two new sections, **Reading** and **Comments and Finish review**, and in Notifications (was Guide notifications), Review assistant, Whose turn, and Trust. A setting that depends on another is indented, and disabled and dimmed while that one is off, its label and description still readable.
- **Notifications:** **A guide is ready or failed** and **A review becomes your turn** each stop their Needs You alerts.
- **Review assistant:** **Run the automatic review**, and **Re-check the agent's comments after new commits**. Off keeps the automatic review's prompt for later.
- **Whose turn:** **Come back when you're mentioned**; **Get a review ready before alerting you**, which off alerts at once, with Update guide and Check again a click away; **Run the re-review check**, which off keeps its prompt; and **Include PRs you've reviewed**, which off finds only requests for you.
- **Reading:** **Open on the Overview when a review comes back**, **Single-key shortcuts** (off, only Esc works, and the key hints go), **Fold files you've viewed**, **Fold lockfiles and generated files** (diffs over 1,500 lines still fold), **Requirements**, **Code owners**, and **CI failures in the code**. With Requirements or Code owners off the assistant still knows them, and the Overview lists failing checks either way.
- **Comments and Finish review:** **Ask agent about selected text**, which off leaves Comment and Ask agent on selected lines; **Check before you approve**, with its pace, 100 to 2,000 lines an hour (500 by default).
- **Trust:** **Start agents on their own**. Off, other people's PRs wait for your click whoever wrote them, and say "Start agents on their own is off in Settings"; the authors setting still decides whose PRs the repo's checks run on.
- A review opens within about a second when settings are slow or can't load, with the defaults until they arrive.
- One invalid saved setting falls back to its default instead of failing every read of settings.

### Before you approve

- With Approve picked, Finish review's Goes to GitHub flags files in high-risk chapters you haven't viewed ("2 files in high-risk chapters not viewed", with **Show**), and each medium- or high-risk chapter of 50 lines or more marked viewed faster than 500 lines an hour ("Chapter 2 (high risk): 1,200 lines marked viewed in 3 min"). Submit asks once more, and **Submit anyway** sends. Lockfiles and generated files don't count.

### How the agent checked

- An agent's draft comment can carry what it read or ran to confirm the problem, with file:line, folded under **How the agent checked** on its card, in the code and in Comments. It stays in BB: submitting never sends it, and your edit drops it.
- The automatic review asks for it, and `bb review comment add` and `edit` take `--evidence`, up to 600 characters.

### Agents and trust

- The assistant and the guide writer read only their own review's diff and PR context. Before, a PR's text could steer them into reading any other review, private ones included, and renaming their thread or editing its metadata could point them at another review's guide.
- A PR whose branch is in someone else's fork no longer runs agents or the repo's checks on its own, even when it's yours or a member's: that fork's owner can push to it. The review says whose fork, with one click to run it. **Anyone** under Trust still runs it.
- The hidden guide writer no longer runs at the project's permission mode, possibly Full Access, on **Project defaults**: it runs at Accept Edits where its provider allows, else Auto, and its skill tells it to use only the plugin's tools and one that reads a linked ticket. **Custom** starts it at the same mode.
- A guide that leaves changed code out of every chapter is refused, so a change can't hide in a low-risk "Other files"; binary, rename-only, and mode-only files still go there. The guide writer hears every error at once.
- The assistant knows each chapter's risk and where to start, and keeps the guide's chapters in its instructions however long your instructions are.

### Fixes

- Esc in a comment, summary, or agent-message box leaves it with your text in it; **Cancel** discards.
- If a comment lands on the line while you write, the box says so and its button reads **Replace comment**; a comment written after the box last heard is never replaced unseen, and the next try goes through.
- A comment box whose line left the diff, after a reload or a guide update, moves to Comments, where you can finish it, instead of staying open where you can't see it and holding Submit.
- Docking or closing a side panel keeps your line in place when the diff redraws to wrap or go unified.
- A comment's discussion with the agent, and its Undo, move with it when Update guide puts it on a new line.
- A review snoozed until a time alerts in Needs You when it comes back, once.
- A stacked PR retargeted to a new base offers **Update guide** ("The PR's base changed from parent to main since this guide was written."), and Submit waits for it.
- **Save settings** keeps keyboard focus when it saves, instead of dropping it to the page; with nothing to save it says it's unavailable and does nothing.

### Installing

- Install, update, and read release notes from this fork's Git repository, at `^0.7.0`; there's no marketplace.
- Removed six server calls nothing in the panel made (`ping`, `getReview`, `getGuide`, `getPatch`, `getPr`, `getThreads`), and `setVerdict`'s `body`, which no panel since 0.4 sends.
- The plugin builds, tests, and typechecks against the SDK BB runs (0.6.37), and typechecking covers the server's tests, the browser tests, and the vitest config.

## 0.6.0 — 2026-10-13

A new review workspace, built so the code owns the screen on a desktop, an iPad, and a phone, with every capability kept but starting new private notes. What gets posted to GitHub doesn't change, and your reviews, drafts, notes, and layout carry over: a review left on Feedback or Threads reopens with Comments open there.

### Layout

- The plugin's top bar and the review's big header are gone, so the code starts right under BB's title bar. On a desktop or an iPad a chapter starts 238px higher, and on a phone 235px higher.
- The review's commands moved into BB's **Guided Review** title bar: **Comments** (its badge counts what needs you), **Ask agent**, **Submit review** with the verdict and how many comments will be sent, **Review actions** (⋯), and **Full screen**. Settings is in ⋯ as **Review settings…**.
- One 44px band over the code says where you are and holds how the code draws: the chapters toggle and **Find in review**, **‹ All reviews**, the chapter with its progress ring, the compare select on a re-review, **Fold comments**, and **Diff options**. In full screen it ends with the review's commands, and toasts, **Undo** among them, show over it where BB shows its own.
- The chapters toggle sits beside Find in review and never moves; `t` shows and hides the chapters.
- The chapters and the side panel dock only while the code keeps 560px; otherwise they slide over it, and Esc, a tap on the code, ✕, or a pick closes them. The diff is never squeezed to 380px again: with Comments open in BB's 1120px pane it's 687px wide, where it was 415.
- The side panel docks narrower, down to 320px, before it covers the code, so it stays beside the code at more widths.
- **Diff options** (the sliders icon) replaces Split view, Wrap lines, Hide whitespace, and the GitHub threads toggle: Layout, Wrap long lines, Hide whitespace changes, GitHub threads in code (now remembered), Collapse all, Expand all, and Keyboard shortcuts. The diff layout moved here from Settings.
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
