# Changelog

## 1.5.1 — unreleased

Fixes from a bug bash of rendered Markdown, and for updates that left the plugin not loaded. Still **BB 0.45+** (plugin SDK **0.6.14+**) with Node 24+; installs at `^1.0.0` update to 1.5.1. 1.5.1 adds no migration, so rolling back to 1.5.0 keeps everything.

- A rendered block draws with the link definitions its links use, where it drew every definition in the file. A file of many, as a changelog whose versions link to their comparisons, froze the page for seconds as it showed: 7 s to show the 1,798 unchanged sections of a changelog of 300 versions, now under half a second.
- Text selected from a block into its "Link changed" note, or to the edge of its row, picks the block's lines. It threw an error in the page and picked nothing, so only Ask agent about the text was offered.
- An update or reload that came while the plugin's update check or a Needs You alert still waited on the network left the plugin degraded and not loaded, and `bb review` unknown, until `bb plugin reload code-review-workspace`: its updates service stopped only once that call returned, past the 5 s BB gives it. It stops at once now, and an update the interrupted check finds isn't applied. The update that installs 1.5.1 still runs 1.5.0's shutdown; if the plugin shows degraded after it, run `bb plugin reload code-review-workspace`.

## 1.5.0 — 2026-10-24

Read a Markdown file rendered, as GitHub's rich diff shows it, and comment on it there. Still **BB 0.45+** (plugin SDK **0.6.14+**) with Node 24+; installs at `^1.0.0` update to 1.5.0. 1.5.0 adds no migration, so rolling back to 1.4.1 keeps everything; a Markdown file then opens as its source, and saving settings on 1.4.1 drops the Markdown files choice, which reads as Source once you update again.

- A `.md` or `.markdown` file's row has **Source** and **Rendered**. Rendered draws the file through BB's own Markdown, a block at a time, a list's top-level items each a block of their own, its images as links: a solid green bar beside an added block, an amber one beside a changed block, and each removed block from the old file, dimmed with a dashed red bar, where it was. **Show previous**, a small button in the gutter shown on hover or keyboard focus, and always on a touch screen, puts a changed block's version before above it; each half of a split paragraph shows the paragraph it was. Frontmatter draws as a table of its keys and values, as on GitHub, and a footnote's definition as its label in bold. Six or more unchanged blocks in a row fold to "9 unchanged sections · Show", keeping the one beside each change, and three or more removed blocks in a row show the first and fold the rest.
- A changed paragraph, heading, list item or quote marks its changed words as GitHub does: deleted words struck on a red tint, then inserted ones underlined on a green. A link's changed words are marked inside it while its URL stays. A change that crosses Markdown's syntax (emphasis, a list's marker or task box, a heading's level, an HTML tag), changes a link's URL, rewrites most of the block, or would draw differently once marked (emphasis inside a word, as in CJK, a reference link's label, a code span over two lines) isn't marked: the block shows changed as a whole. Code, tables, math, HTML, and blocks with strikethrough show changed as a whole. An ordered list's items draw with their numbers in the list, and items an insertion renumbers stay unchanged. A changed block says which of its inline and reference links now go elsewhere: "Link changed", its words, and the old and new URLs. A changed table tints its new rows green and its changed ones amber, with an edge on each, where BB drew the rows its source has.
- The marks rely on BB's Markdown drawing `<del>` and `<ins>`, as BB 0.46 does. Rendered files mark words only once a hidden probe shows BB's Markdown drawing `<del>` and `<ins>`, once a page; until then, as while its HTML loads the first time, and on a BB that drops raw HTML, changed blocks show whole.
- On a PR, relative links, inline and in link definitions, go to their files at its head on GitHub, from the file's folder or, with a leading `/`, the repository's root, never above it; a query or fragment alone goes to the file itself. Images stay links. A local review's links stay as written.
- Comments, GitHub threads, CI failures and the comment box show after the block holding their line, and outdated threads in the file's fold, as in the source. A block the diff shows has a comment button left of its bar, shown on hover or keyboard focus, which opens the box on its lines in the diff, in one hunk: a removed block's on its removed lines. A table has one for each row the diff shows, shown as the pointer is over the row, named by its row ("Comment on table row 2 (line 22)"), and one stop for the keyboard, the arrow keys moving between rows. Selecting text picks the lines it covers, for **Comment** or **Ask agent**: a table's rows, a code block's lines, or the lines of prose the selected words are on, read as drawn without deleted words (where the words around an end show more than once, as drawn or in the source, as a link's can, the whole block's); in blocks the diff doesn't show, which GitHub takes no comment on, the selection offers **Ask agent** alone, with their source. Every comment is on lines GitHub takes, so it shows at the same line in the source.
- Diff options' **Markdown files** opens every Markdown file as **Source** (the default) or **Rendered**, remembered for every review; `m` switches the current file. ⇧J and ⇧K step through changed blocks.
- Rendered is off, saying why in its tooltip, while the diff shows only what changed since your review, for a file split across chapters, and when the file's contents can't load; the file shows as its source.
- MDX files stay as their source. A list item's nested items are part of it, so a change to one marks its top-level item. A moved block shows as removed where it was and added where it went.

## 1.4.1 — 2026-10-23

Fixes from a bug bash of the Postgres storage and the flows around it. Still **BB 0.45+** (plugin SDK **0.6.14+**) with Node 24+; installs at `^1.0.0` update to 1.4.1. 1.4.1 adds no migration, so rolling back to 1.4.0 keeps everything.

- A **Suggest instruction changes** run that a reload, an update or turning the plugin off interrupted could end BB's server process, which BB then restarted. It ends quietly now, and still stops its worker. The update that installs 1.4.1 still runs 1.4.0's shutdown, so apply it while no suggestion is running.
- A failure to clear a review's Needs You alert as it left Needs review is logged, where it was a rejection nothing handled, the kind that ends BB's server.
- A review or reply GitHub took is never posted twice when the plugin's storage fails as it records it. Submit or Send said only that it failed and kept the draft, so trying again posted it a second time. Recording is tried three times; if it still fails, the message says GitHub has it and that Submit or Send again, without changing the draft, finishes recording it, all of it when recording failed part way, without posting it again, after a reload too. Only the same review on the head it was for, or the same reply still drafted, counts as the one GitHub took, text differing only in its line endings or the whitespace around it being the same: a review whose draft changed, or submitted after a rebuild for new commits, posts, the comments GitHub already has leaving the draft first (that Submit says so and posts nothing), and a reply drafted again after its draft was discarded or changed posts. While bb's key-value store, which keeps the note of what GitHub took, can't be read, Submit and Send post nothing and say "Couldn't check whether GitHub already has this; try again." When it refuses to keep that note, as one over 256 KB, the plugin keeps it in memory only and the message says not to reload: a reload forgets it, and the next Submit or Send posts it again.
- With the reviews in Postgres, a `postgresSchema` or `postgresUrl` that names a schema without them, as after a typo or with another database, is reported as needs-configuration ("… holds none: check postgresUrl and postgresSchema") and nothing is served. The plugin made empty tables there and served an empty review list, so every review seemed gone and new ones went to the wrong schema. Only `bb review storage migrate` makes a schema now.
- A NUL character, which git puts in a text diff past a file's first 8,000 bytes and an agent's or your text can carry, is stored as U+FFFD (�) on both backends. On Postgres, which can't hold it, such a diff left a new review building for good, failed every rebuild of it, and an agent comment holding one couldn't be edited or removed, or recorded after Submit. `bb review storage migrate` copies one in `data.db` as U+FFFD too, where it refused to copy anything.
- A new review whose diff failed to save, as when the storage dropped its connection, no longer stays building for good: the diff is saved before the review is marked as building, so starting it again builds it.
- After a reload, an interrupted guide whose restart fails, as when the storage fails mid-rebuild, stays failed saying why, and the guides after it restart. It stopped the rest restarting, and said nothing.
- What a storage failure left in progress, until a reload, settles on the next review-state pass, once a minute: a guide whose run ended as Postgres went away, which stayed generating (Rebuild did nothing and Delete was refused), fails, saying why, so Rebuild works; and a feedback check ("Checking your feedback…"), a discussion waiting on the assistant, or an ask on the summary or a comment, whose turn ended unheard, stops waiting once it's two minutes old and its assistant has stopped. A guide run's end that couldn't be recorded is logged, unless a reload or an update stopped the run.
- On Postgres, a start whose opening of the storage failed part way, as on a statement timeout, and was tried again still stops and archives the guide writers a reload interrupted, and restarts their guides. The next try found none, so they ran on unarchived and their guides never restarted.
- A guide writer whose thread fails, as when its agent can't launch, leaves the review saying "The guide writer failed:" and BB's reason, in the panel and the log, where it said "This operation was aborted."
- The review-state pass, once a minute, no longer reads every guided review's whole diff again for what agents are configured with: a review's guide is read again only after something that can change it. With more than 8 guided reviews, each pass read them all, a 1.3.0 regression.
- The review-state pass no longer writes a review's state, or its feedback threads, when they're as they were: it rewrote each PR review's every minute.
- While Postgres takes connections but answers nothing, as when its node or the network drops packets, the calls waiting behind one that timed out connecting fail at once, where each waited out its own 10 s connect timeout in turn: five took a minute.
- A call with a number the store can't keep exactly, as a viewed time past 2^53 or with a fraction, or a line past 2^31, is refused as invalid. On Postgres such a time was stored and then broke every read of the review's viewed files, and the rest failed with a server error; SQLite kept them inexactly.
- On Postgres, a statement timing out, a lock not granted or a deadlock while the plugin opens its storage counts as passing, as Postgres being out of reach does: it's reported as needs-configuration only if it lasts a minute, where it was at once, and BB kept saying so until a reload though the storage opened a second later.
- While the plugin opens its Postgres storage, `bb review` says so, with the latest try's error, and points to `bb review storage status`, where it printed only pg's error, such as "timeout expired".
- With `postgresSsl` set to `verify-full`, a server certificate the CA in `postgresCaPem` didn't sign, one that doesn't name the host, or one that has expired is reported as such, naming the setting to check, where Node's message suggested running Node with `--use-system-ca`.
- A draft comment Postgres refuses to save, as on a file whose path is past about 2.7 KB, leaves the draft as it was, where it could keep the comment with no record of the diff it was drafted on. [docs/operations.md](docs/operations.md#storage-backends) says what such a path can't do on Postgres.
- The **Storage** setting says that changing it alone stops the plugin at its next load, until `bb review storage` moves the reviews or it's set back.

### Docs

- `bb review --help` lists `bb review storage`, and says to give a git ref named `comment`, `summary`, `list` or `storage` as `refs/heads/<name>`. While Postgres is still opening, `export-sqlite`'s refusal says the plugin opens the reviews from it, not that it serves them.
- [docs/operations.md](docs/operations.md#storage-backends) says that only `export-sqlite --replace-data-db`, not `export-sqlite` alone, changes `storage:owner`; which PG* environment variables pg still reads; that a connection error can show the host, though never the password or the URL as set; that the password is briefly visible in the server's process list while `bb plugin config … set` runs; what's left in progress after a Postgres outage, and how long calls take to fail while Postgres hangs; how to restore, or start over, when the schema holding the reviews is lost; and, with the guide's Uninstall, to copy `data.db` and the export and backup files off the server before `bb plugin remove`.

## 1.4.0 — 2026-10-23

Send an approval to the thread that made the change. With no comments in the draft, Finish review on your own PR or a local review can tell it "Approved", and what Send to thread sends can carry your message and the review summary. Still **BB 0.45+** (plugin SDK **0.6.14+**) with Node 24+; installs at `^1.0.0` update to 1.4.0. 1.4.0 adds no migration, so rolling back to 1.3.0 keeps everything; a sent approval's record stays, unused, until you update again.

- With no comments in the draft, Finish review on your own PR or a local review offers **Send approval to ‹thread›**, where it offered nothing: it asks for an optional message and, when the draft has a summary, whether to include it (unchecked), then sends the thread that made the change one message, "Approved", followed by your message and the summary if you add them, and says "Sent to ‹thread›" or "Queued in ‹thread›", with **Open**. It's offered once for each diff, and approves only the diff the page shows: if new commits arrived since, or the guide is rebuilding, it sends nothing and asks you to open the latest. A comment you add goes as before. Nothing goes to GitHub.
- Comments sent to the thread that made the change no longer end with "Don't push … unless I ask": that thread keeps its own rules about GitHub. **Fix in a new thread** still says it.
- **Send N comments to ‹thread›** takes the same optional message, sent before the comments, and **Include the summary**, unchecked, which adds the review summary after them. Fix in a new thread is unchanged.

## 1.3.0 — 2026-10-21

Keep the reviews in Postgres, if you'd rather they weren't on the BB server's disk. SQLite stays the default: an install that changes no setting keeps its reviews in `data.db` and works as before. Still **BB 0.45+** (plugin SDK **0.6.14+**) with Node 24+; installs at `^1.0.0` update to 1.3.0. 1.3.0 adds no SQLite migration, so rolling back to 1.2.0 on SQLite keeps everything; from Postgres, export the reviews to SQLite first. Postgres was rehearsed on BB 0.46.1 with Postgres 18.

### Postgres

- Six settings choose it: **Storage** (`storageBackend`: `sqlite` or `postgres`), `postgresUrl` (`postgres://user@host:port/database`, with no password or query parameters), `postgresPassword` (a BB secret), `postgresSchema` (`code_review_workspace` by default, created if it's missing), `postgresSsl`, and `postgresCaPem`. They apply when the plugin reloads.
- `postgresSsl` is `require` by default: TLS, signing in only with SCRAM channel binding, and refusing a server that asks for a password any other way. It needs no certificate on the BB server and outlasts a CA's renewal. `verify-full` checks the server's certificate against `postgresCaPem`, or Node's CAs; `disable` is for local development.
- The plugin holds one connection, and a writer lock on its schema, so one BB writes to a schema at a time; a reload hands over without overlap.
- If Postgres restarts or the network drops, the call in flight fails and the next one connects again. A plugin starting while Postgres is away keeps trying and serves once it answers; it reports needs-configuration after a minute, or at once for a wrong password, a refused sign-in, or a lock another BB holds.
- No message or log line shows the URL or the password.

### Moving the reviews

- `bb review storage migrate` copies the reviews from SQLite to an empty Postgres schema, checks every table's rows and next ids on both sides before it commits, and only then marks Postgres as holding them. Nothing is written if a check fails or Postgres goes away mid-copy; run it again.
- `bb review storage export-sqlite` copies them back to a new, checked `data-export-….db` beside `data.db`; `--replace-data-db` backs `data.db` up and replaces its reviews with the copy.
- `bb review storage verify` compares SQLite and Postgres table by table, and `bb review storage status` says which backend the settings choose, which holds the reviews, and whether the plugin serves.
- While the setting and where the reviews are disagree, the plugin is in maintenance: only `bb review storage` answers, nothing writes, and BB shows needs-configuration with what to run. It never falls back to the other backend.
- `migrate` and `export-sqlite` run from a terminal on the BB server, not from a BB thread.

### Also

- Reviews created in the same millisecond come in order of their key, where they came in the order they were saved.

### Docs

- [docs/operations.md](docs/operations.md#storage-backends) covers Postgres: setting it up, the settings, what each TLS mode guarantees, the single writer, maintenance mode, `bb review storage`, backups, rolling back to SQLite, and what `bb plugin remove` leaves in Postgres.
- The guide's [Storage](docs/guide.md#storage) says where the reviews are, and Troubleshooting what "Couldn’t open the review session" can mean.
- [docs/development.md](docs/development.md#backend-tests-on-postgres) says how to run the backend tests, and a copy of a real `data.db`'s round trip, on a throwaway Postgres 18.

## 1.2.0 — 2026-10-20

Give a review a name of your own. **Rename…** in its ⋯ menu changes what your lists call it, and nothing on GitHub; its Overview keeps the PR's title under the name. Still **BB 0.45+** (plugin SDK **0.6.14+**) with Node 24+; installs at `^1.0.0` update to 1.2.0. Rolling back to 1.1.3 keeps the names, unused, until you update again.

- **Rename…** sits between Pin and Archive in **Review actions**: on a row in All reviews, in a review's title bar, and on the page of a review without a guide. Its dialog opens with the name selected, so typing replaces it; Enter saves, Esc cancels, and the toast has Undo.
- All reviews, Needs review included, BB's thread list, the review's band, Finish review's next review, Needs You alerts, and the title of a **Fix in a new thread** thread use your name.
- The PR's title stays in view: under your name on the Overview, on hover in All reviews and BB's thread list, and in the dialog, with **Use PR title**. The find box matches your name or the PR's title.
- GitHub and the agents keep the PR's title. Your name stays when the author retitles the PR or pushes, and when the guide is rebuilt; **Use PR title**, or an emptied box, puts the title back, and Delete forgets it. A local review's name stands in for its ref, with **Use ref**.
- `bb review list` adds `named "…"` after a renamed review's title, and `--json` a `name`.

## 1.1.3 — 2026-10-20

**All reviews** is easier to scan: each review stands on its own, and the sections and their parts read as headings.

- A part's reviews (**Back to you**, **New**, **Team requests**), or a section's, sit in one card with a line between them; a stack keeps its left rule inside the card.
- Section headings are a size larger, with their count in a badge. **Needs review**'s is filled, like the title bar's needs-you badge, while anything needs you.
- Back to you, New, and Team requests are small capitals, like Finish review's part headings.
- The repository and number are a tier quieter, so the title leads.
- "Nothing needs you right now" sits in a dashed box, and the list loads as a card of placeholder rows.

### Docs

- The README shows what the plugin does, a feature at a time with a screenshot, then requirements, a quick start, and moving from Guided Review. The full reference moves to [docs/guide.md](docs/guide.md). It adds Troubleshooting, Uninstall, What the agents can and can't do, and Other settings and defaults, and moves notes for older versions into Upgrading from older versions.
- Contributor and operator detail moves to [docs/development.md](docs/development.md), [docs/operations.md](docs/operations.md), and [docs/devices.md](docs/devices.md).
- PRODUCT.md describes the plugin as it is now, and [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) is the marketplace overview.
- The README's All reviews screenshot shows the new list.
- The plugin's description says "review agent", as the UI does, and `package.json` has keywords. The `code-review-workspace` skill lists every option `bb review comment` takes.

## 1.1.2 — 2026-10-20

- Use the magnifying glass and code brackets for each review row in **Needs review** and **Pinned**.

## 1.1.1 — 2026-10-20

- Replace the clipboard icon with a magnifying glass and code brackets.
- Use the same SVG in the sidebar menu and the homepage’s **Needs review** heading.

## 1.1.0 — 2026-10-20

The diff reads more like the code it shows. A file the PR adds is drawn as a file, not a wall of green; long runs of deleted lines fold after their first three; a split's empty side, the bands between hunks, and line numbers say less and show more; and ⇧J and ⇧K step through the changes. One new preference, **New and deleted files** in Diff options, saved for every review; no new switches, and every switch means what it did. Still **BB 0.45+** (plugin SDK **0.6.14+**) with Node 24+; installs at `^1.0.0` update to 1.1.0. Rolling back to 1.0.0 keeps your reviews, drafts, and settings: 1.0.0 drops the new preference when it reads them.

### New and deleted files

- A new file shows as a file: its code in full syntax on the canvas, plain line numbers, and one rail in the add color beside them, under a **New file** badge and its length ("65 lines") in place of +65 −0.
- A deleted file starts folded, "Deleted · 65 lines" with **Show diff**. Shown, it has a dashed rail and its syntax dimmed, still 4.5:1 or more on the canvas and under a text selection.
- **Show as diff** in the file's row, or **New and deleted files** (As file | As diff) in Diff options, draws them as diffs instead, in every review.
- A new or deleted file is always unified, with one column of numbers, even with Layout on Split.

### Reading a diff

- Unified diffs show old and new line numbers in their own columns, old on the left, as a deleted line has only an old number and an added one only a new number. Under 560px, one column, as before.
- "N unmodified lines" is one quiet band across the row, and across both sides of a split, followed by git's function context ("export function unquote(name: string) {"). Its expand arrows show 20 more lines a click, up and down side by side, each at least 24px square.
- A split's empty side is a flat recess a step below the canvas, without the hatching.
- + and − are bold, in the diff's add and delete colors, with a true minus, and never copied with the code. Beside them, a 3px bar at the gutter's edge: solid for added lines, dashed for deleted ones.
- 40 or more deleted lines in a row fold after their first three behind one row tinted like them, "Show 174 more deleted lines · old 17–190". It opens in place and keeps the focus, says **Hide 174 deleted lines** once open, and starts open when a comment, the comment box, a CI failure, or the lines you picked are in it; going to a line in it opens it. A comment on the last line shown keeps its own look above the fold's button. Added lines never fold.
- A deleted line and the added line paired with it that share under 40% of their text lose their word emphasis, which marked nearly every word.
- Lines new since your review carry a mark in the code's ink on the seam between number and code, with no tint, so a deleted line keeps its color.
- A selected line's number keeps the selection color in a file shown as a file.

### Comments in the code

- A comment's card hangs from its line at a measure of 72 characters, on the canvas, its line's number in the code's ink at 600 with a hairline down the gutter to the card's foot. Outdated threads keep the same measure.
- A resolved GitHub thread starts as its pill; **Resolve** from the card keeps it open, and its **Hide** folds it.

### Keys

- **⇧J** and **⇧K** go to the next or previous change in the chapter's code, a folded run and a split's two sides each one stop. Each is centered, outlined a moment, and said ("Change 3 of 12 · src/http.module.ts:34"); past the last, the next or previous file. Held down, they repeat, and keep going from the change they went to while the scroll there runs.

## 1.0.0 — 2026-10-19

Guided Review is now **Code Review Workspace**, maintained by Andrew Bird, and installs from `github.com/AndrewBird81/bb-plugin-code-review-workspace`. It began as a fork of Pritam Sharma's [bb-plugin-guided-review](https://github.com/notpritam/bb-plugin-guided-review), credited in the README, LICENSE, and `package.json`. The new name takes a new plugin id, `code-review-workspace`, so it's a new install, not an update: see [Moving from Guided Review](README.md#moving-from-guided-review). Still **BB 0.45+** (plugin SDK **0.6.14+**) with Node 24+; install at `^1.0.0`.

- The first start copies in a Guided Review install's reviews, guides, drafts, private notes, and settings, when it has none of its own, and Guided Review's review assistants keep their tools.
- The panel, settings section, palette commands, Needs You alerts, and `bb review`'s words say Code Review Workspace. `bb review` and everything it takes are unchanged.
- The skills for agents are `code-review-workspace` and `code-review-workspace-generate`; agents fetch a PR's head into `refs/code-review-workspace/`.

## 0.8.2 — 2026-10-19

Fixes only, from a bug bash of 0.8.1. Text someone else wrote can no longer load an image, freeze the page, or stall the plugin's server; draft comments stay on their own code through a guide update, and leave the draft once they're submitted; an automatic review that couldn't start, or that waits for your click, says why; and the keyboard focus stays put through Submit, a comment's actions, and All reviews' quick actions. Nothing new to turn on or off, and every switch means what it did. Guided Review still needs **BB 0.45+** (plugin SDK **0.6.14+**) with Node 24+, and installs at `^0.8.0`, which updates to 0.8.2.

### Untrusted text

- Images in other people's comments and the agents' words show as links after a fence line holding U+2028 and a backtick, after a byte order mark, inside a `<scheme: …>` BB can't read as a link, and in a reference image's label.
- A comment of nested or unclosed `![` openers, or a long line of footnote openers, opens at once rather than freezing the tab. An image inside an image's alt shows as its words.
- A CODEOWNERS rule of many stars, or a long `applyTo` line in the base's instructions, no longer stalls the plugin's server.
- A lockfile names a new download host written with JSON, YAML, or TOML escapes, in a one-line entry, or before `?@` or `#@`.
- A `**/` rule in `.gitattributes` or an `applyTo` matches as git does: `types.ts linguist-generated` no longer folds `src/user-types.ts`.
- A changed path holding a line break, U+2028, U+2029, DEL, or a C1 control is quoted wherever the agents read it, and a pure copy is listed under the path it was copied to.
- Diff lines quoted to the agent, from a discussion or your selection, and a failing check's name in Ask agent sit inside fences their text can't close.
- A local review refuses a range whose right side reads as an option, as it did its left.

### Agents and trust

- `bb review --context` reaches the agents fenced as untrusted context from the thread that started the review, not in your voice, and a review's own agent can't set or remove it. The command says when the automatic review won't run, on a merged or closed PR and after your review too, that the context goes with **Run review** on a guide waiting for it, and that the assistant can still read it.
- With **Start agents on their own** off, `bb review` from one of your threads counts as your click only on your own PR.
- An automatic review that couldn't start, as with its agent's machine offline, says so and why ("Not run automatically: it couldn’t start (…)"), with **Run review** to try again; one that would have waited for your click anyway says that instead.
- **Run review** on a review whose conversation is under way sends the automatic review there. With the automatic review off or the PR merged or closed, Run review, and with the re-review check off, Run check, say why nothing ran and keep the notice.
- A guide the writer submits after **Stop** is refused, so a stopped guide stays stopped, and its status line says "Guide stopped" in neutral, not "Guide failed" in red. **Build the guide** and **Try again** work on a merged or closed PR whose first guide stopped or failed.
- A guide a reload interrupted says why it failed, when GitHub couldn't be read or its writer's machine never came back. A writer whose start a reload interrupted is stopped and kept to its review, without taking in a thread retitled to look like it; the Suggest instruction changes worker is kept off every review from its first command; and `bb review` during an Update guide's PR read leaves one writer.
- Since your review and the assistant's feedback check read the diff at the commit they name, not a later push the sync hadn't seen, and a commit picked in Since your review no longer stores its whole diff. On a PR of more than 250 commits, the assistant isn't told your reviewed commit was force-pushed away when GitHub just didn't list it.
- A first guide no longer shows "Since your review".
- Finish review's "Read 6 of 8 files" counts only reads of a file as the change leaves it. A read past the end of a diff or a file fails, saying its length.
- A chapter can no longer take the id `overview` and hide the Overview; a guide stored with one reads back with it renamed. A guide's intent, since-review note, and requirements are capped as its other text is, and `list_review_files` pages a huge PR's list.
- Turning **Keep pre-existing problems apart**, **Show what the agent checked**, or **Flag weakened tests** on or off reaches an idle conversation's next message.

### Commands

- `bb review`, `bb review comment`, and `bb review summary` take `owner/repo#n`, and a PR link whose owner holds `_`, as an Enterprise Managed User's does.
- After a repository is renamed, the PR link `bb review list` prints finds its review, and `bb review` or a pasted link no longer starts a second one.
- `bb review` refuses `--base` with a range, rather than review the range under the base's name, and gives its usage for a target of only spaces rather than an error.
- While a first guide is written, `bb review comment` and `bb review summary` say the draft waits for it, not that the review is being regenerated.
- `bb review` and a pasted link that start, rebuild, or unarchive a review tell open pages at once, and `bb review list` keeps a stack's reviews together, as All reviews does.
- The usage BB shows agents names `--evidence`; the skill names `--pre-existing`, and says Finish review sends comments back only on a local review or your own PR.
- While Guided Review updates, its refusals say "Try again in a moment.", not to reopen the panel.

### Comments and Submit

- Comments Submit posted leave the draft even when a guide update moved them while it posted, so the next Submit doesn't post them again. A failed Submit is no longer taken for a review with the same verdict and summary submitted from here a moment before.
- A draft comment follows its exact code through a guide update: a comment on code as common as `}`, whose neighbouring lines changed, shows as on an older diff rather than landing on another `}`.
- **Undo** of a removed comment puts it back only on the diff it was removed from.
- A comment box restored after a reload warns before it replaces a comment its line got meanwhile. An edit box follows its comment when a guide update moves it; when the comment was removed, it stays on its line and says so, and no longer becomes an edit of another comment with the same words.
- **Move to summary** on a comment that's only a suggestion keeps the summary's fences paired.
- `1`–`4` or `0` on a comment whose box is open sets the box's severity too, so Save keeps it.
- Replies sent on two threads at once can't post one of them twice.
- A summary, verdict, viewed mark, or reply draft saved from a page after its review was deleted is refused.
- Errors say "Couldn't" and "can't" in the last three places that didn't.

### Reading

- Marking a chapter viewed, or Mark viewed and continue or finish, leaves a file split across chapters for the last chapter holding its hunks, and the toast says where it continues, with Undo.
- A Viewed mark that didn't save is put back and says so, and Mark chapter viewed says Marked once its marks save. A file you just marked stays ticked while an older read comes back.
- A file whose path or added lines hold hidden bidirectional Unicode says so. A binary, mode-only, or empty file's card says what its diff does, and a file GitHub sent no diff for says to read it on GitHub, not "New empty file.".
- With git's `diff.suppressBlankEmpty`, a local review's lines keep their numbers, and comments their lines.
- The review no longer says your account can't access the repository when GitHub just couldn't be reached, and a 401 says GitHub refused your account's credentials.
- CI failures reported after you open the review show on their lines, and stay there while a new CI state is read.
- **Next unviewed** from a chapter's intro opens its first file. A local review says a file "isn't in this diff anymore", not "in this PR". A review just under an hour reads "about 1 h to read".

### Whose turn, alerts, and All reviews

- Turning on **Include team requests** fills the list with your teams' requests without starting guides or alerting.
- A pre-existing nit you submit counts as non-blocking, as a plain nit does.
- Your threads on a PR are still read after about 30 replies of yours.
- Opening a review dismisses its Needs You item at once, and an alert waiting for its re-review no longer comes after you've opened it. An alert waiting in the outbox isn't sent once its switch is off, and a snooze's wake alert is a new event rather than the first alert's again.
- A renamed repository's PR gets no second row. Reading one review keeps All reviews' sync warning, and Update guide and the new-commits check no longer wait for the whole sync pass. A rate-limited notifications check no longer doubles how often reviews are read.
- All reviews says GitHub CLI isn't on the BB server when `gh` is missing, not that GitHub couldn't be reached.
- A review already in Archive offers no Archive.
- Between midnight and 9 AM, **Pick a date** can choose this morning.
- A narrow phone dock's Comments shows only its count, so the chapter keeps its title.

### Keyboard and screen readers

- Submit keeps the focus while it posts, then hands it to the receipt. A comment card's actions and Send reply keep it while they save, and a removed comment hands it to the next comment.
- All reviews' quick actions and Snooze choices keep the focus while they run, and once a review leaves its section, from its row or its ⋯ menu, it moves to the next row.

### Settings

- Settings says which **Start guides automatically** line it can't take and holds Save, rather than "rpc input validation failed".
- Settings shows another window's save while it has no unsaved edits.
- **Include PRs you've reviewed** says it brings in PRs that changed in the last 60 days.

### Installing

- Install and update at `^0.8.0`. No new settings; what's stored only gains optional fields that 0.8.1 ignores. Idle review agents restart once, to take the agents' new tool options.
- After a rollback to 0.8.1, an automatic review that couldn't start shows 0.8.1's general not-run words, and a comment box restored after a reload no longer tells an edit from a new comment.

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
- A failed guide update says why under its notice, in up to 3 lines. Try again on it brings up the update's notice, rather than keeping the failed one beside it.
- A guide waiting for its writer's machine to reconnect says so on its page, in its update notice, and in its status line, with Try again, rather than that it failed; once its 10 minutes are up, it reads as failed at once.
- `r` on a GitHub thread opens its reply box even when its card in the code shows after the key, as when `]` turns GitHub threads in code back on.
- **Suggest change** fences its lines with more backticks than they hold, and a Suggested change opened with four or more backticks shows in its box, a fence among its lines included.
- A draft comment's actions in the code wrap on a phone, rather than running past its card.
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
