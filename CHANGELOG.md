# Changelog

## 0.5.1 — 2026-10-11

- **Needs review** in BB's thread list: the reviews waiting on you, below Pinned and Threads, collapsible like them. Choosing one opens it, and closes the sidebar on a phone.
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
