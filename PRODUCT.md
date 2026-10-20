# Code Review Workspace

Code Review Workspace is a BB plugin for understanding a GitHub pull request or local Git change through an agent-authored chapter guide. Reviewers inspect diffs, track viewed files, ask an agent about the change, and prepare comments and a verdict in the same workspace. Its incumbent interface is an **Operate** surface inside BB: the review list starts or resumes work, and the chapter workspace supports the review itself.

This is the product description for contributors: what the plugin is for and what it does now. [README.md](README.md) shows what it does, [docs/guide.md](docs/guide.md) is the user guide, [DESIGN.md](DESIGN.md) the interface system, and [CHANGELOG.md](CHANGELOG.md) the version history.

## Who it's for

Reviewers who need to understand a change well enough to approve it, often one an agent wrote. It is the place to read, discuss, and approve a code change, PR or local. It is not a tool for posting an agent's findings one by one.

## Workflow

The panel accepts complete `github.com` pull-request URLs and `owner/repo#n`. The `bb review` command also accepts PR numbers and local Git references when run from a project checkout. A configured BB coding-agent provider generates the guide, with every changed file assigned to one chapter.

First-run help explains provider setup, server-side GitHub authentication, local reviews, and submission. Account checks, review loading, generation, draft loading, saves, and submission expose visible failure states and recovery actions. A failed draft load pauses editing; a failed submission retains the draft.

Drafts stay in BB until the reviewer explicitly submits a GitHub verdict. The review agent drafts line comments and the review summary, and suggests a verdict; the reviewer refines them in discussions with it and picks the verdict. Replies to existing threads and resolve actions are separate immediate GitHub writes. Reviews are pinned to the inspected PR snapshot; a PR with new commits or a new base needs its guide updated before submission, and drafts whose lines are gone must be edited or removed first. Local reviews have no GitHub submission action.

## What it does

- **Reading.** A review opens on its Overview, what the PR is and where it stands, the first time and whenever it comes back to the reviewer; it then reads chapter by chapter, code first, on a desktop, an iPad, and a phone. The guide checks the PR against what its description and linked tickets ask for, points to the riskiest lines, and says what to verify in each risky chapter.
- **The diff.** The diff reads like the code it shows. A file the PR adds is drawn as a file, with a rail beside its code rather than a wall of green, and a deleted file starts folded and, shown, is dimmed; either can be shown as a diff instead, a preference kept for every review. Long runs of deleted lines fold after their first three, opening where a comment, a failure, or the reviewer's selection is in them. Unified diffs give old and new line numbers their own columns, the bands between hunks name the function after them, a split's empty side is a flat recess, and word emphasis is dropped where a line was rewritten rather than edited. ⇧J and ⇧K step through the changes. Comments hang from their lines at a readable measure.
- **Flags.** Test files that lose assertions and lockfiles that add packages or download hosts are flagged, as is hidden bidirectional Unicode.
- **Comments.** Each draft comment carries a severity (Blocking, Should fix, Question, or Nit) that GitHub receives as its label, so authors see what matters and the reviewer can set nits aside; nit, FYI, and optional threads don't hold a review on its author. Every comment, drafted or on GitHub, shows at its line with all its actions and in one Comments list beside the code, marked as not submitted, on GitHub, or private with the agent, so a re-review can happen in the code.
- **The agent's drafts.** An agent's draft comment carries how it confirmed the problem, which stays in BB. The agent marks problems the PR didn't introduce as pre-existing, which don't hold an approval. Comments can be triaged from the keyboard, removed with a reason the agent learns from, or moved into the summary when their lines are gone.
- **Finish review.** Finish review gathers the summary, the verdict, and exactly what will be posted, then offers the next review that needs the reviewer. With Approve picked, it flags unviewed files in high-risk chapters and chapters marked viewed faster than anyone reads, and it says how many files the agent read and what it didn't check.
- **Whose turn.** The list tracks whose turn each review is: a push alone never makes it the reviewer's turn, while a re-request, a question, or handled feedback does, with one Needs You alert. On re-review the agent checks each piece of the reviewer's earlier feedback against what changed, and the reviewer decides; replies, resolves, and verdicts still post only on explicit action.
- **The thread that made the change.** A review started with `bb review` in a thread remembers it: Finish review sends the reviewer's comments back there on a click, and the cards say what was sent. A local review notices when its code changed since its guide.
- **Trust.** Agents start on their own only on PRs from the repository's members and collaborators; for anyone else the review says what didn't run and runs it on one click, since a PR's text and code can try to steer an agent that reads them. A PR whose branch is in someone else's fork waits for the reviewer's click whoever opened it. Agents read only their own review, and read the repository's AGENTS.md, CLAUDE.md, REVIEW.md, and `.gitattributes` from the PR's base, never its head; the Overview says when a PR changes them. The hidden guide writer runs at the lowest permissions its provider allows. Replies and resolves post as the verified account.
- **Control.** Settings has a switch for each feature that can get in the way, from single-key shortcuts and folding to alerts and agents starting on their own, each on by default and saying what stays when it's off. BB's command palette offers the next review that needs the reviewer and a review of a copied PR link.
- **Name.** The plugin was Guided Review, with the id `guided-review`, until 1.0.0. It is now Code Review Workspace, with the id `code-review-workspace`; its first start copies in a Guided Review install's reviews, drafts, and settings. Private reviewer notes from older versions stay in Finish review and are never sent.

## Distribution and operating limits

Code Review Workspace runs on BB **0.45.0+**, Node **24+**, and plugin SDK **0.6.14+**; [CHANGELOG.md](CHANGELOG.md) lists each release. Reviewers need their own BB installation and GitHub authentication. It does not provide shared review workspaces or separate user accounts within one server.

Git and `gh` run on the BB server. Local review checkouts must exist there; a checkout only on another enrolled machine is unsupported. GitHub features currently support `github.com`. Account switching affects that server’s `gh` credentials, including other consumers; environment-token overrides must be cleared before switching saved accounts.

Metadata, patches, guides, and drafts reside in the installation’s plugin database. Review agents receive context through the configured provider. Sharing a BB server shares its credentials and plugin storage. See [README.md](README.md) for installation, [docs/guide.md](docs/guide.md) for use, and [docs/operations.md](docs/operations.md) for running it.

## Updates

The plugin uses BB’s native compatibility checks, installation, and rollback. Manual update controls live in Settings. Automatic updates are opt-in and wait for five idle minutes with no open review/Settings pages and no active work. Unsaved public drafts have per-tab recovery with their original review revision; private notes remain separate.
