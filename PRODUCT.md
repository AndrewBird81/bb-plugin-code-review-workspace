# Guided Review

Guided Review is a BB plugin for understanding a GitHub pull request or local Git change through an agent-authored chapter guide. Reviewers inspect diffs, track viewed files, ask an agent about the change, and prepare comments and a verdict in the same workspace. Its incumbent interface is an **Operate** surface inside BB: the review list starts or resumes work, and the chapter workspace supports the review itself.

## Workflow

The panel accepts complete `github.com` pull-request URLs and `owner/repo#n`. The `bb review` command also accepts PR numbers and local Git references when run from a project checkout. A configured BB coding-agent provider generates the guide, with every changed file assigned to one chapter.

First-run help explains provider setup, server-side GitHub authentication, local reviews, and submission. Account checks, review loading, generation, draft loading, saves, and submission expose visible failure states and recovery actions. A failed draft load pauses editing; a failed submission retains the draft.

Drafts stay in BB until the reviewer explicitly submits a GitHub verdict. The review assistant drafts line comments and the review summary, and suggests a verdict; the reviewer refines them in discussions with it and picks the verdict. Replies to existing threads and resolve actions are separate immediate GitHub writes. Reviews are pinned to the inspected PR snapshot; a PR with new commits or a new base needs its guide updated before submission, and drafts whose lines are gone must be edited or removed first. The list tracks whose turn each review is: a push alone never makes it the reviewer's turn, while a re-request, a question, or handled feedback does, with one Needs You alert. On re-review the assistant checks each piece of the reviewer's earlier feedback against what changed, and the reviewer decides; replies, resolves, and verdicts still post only on explicit action. Local reviews have no GitHub submission action.

Version 0.5.0 makes the review itself sharper. Each draft comment carries a severity (Blocking, Should fix, Question, or Nit) that GitHub receives as its label, so authors see what matters and the reviewer can set nits aside; nit, FYI, and optional threads no longer hold a review on its author. Guides check the PR against what its description and linked tickets ask for, and point to the riskiest lines and what to verify in each risky chapter. Agents start on their own only on PRs from the repository's members and collaborators; for anyone else the review says what didn't run and runs it on one click, since a PR's text and code can try to steer an agent that reads them.

Version 0.6.0 gives the review the screen on a desktop, an iPad, and a phone. A review opens on its Overview, what the PR is and where it stands, the first time and whenever it comes back to the reviewer; it then reads chapter by chapter, code first. Every comment, drafted or on GitHub, shows at its line with all its actions and in one Comments list beside the code, marked as not submitted, on GitHub, or private with the agent, so a re-review can happen in the code. Finish review gathers the summary, the verdict, and exactly what will be posted, then offers the next review that needs the reviewer. Private reviewer notes are no longer a tool; existing notes stay in Finish review and are never sent.

Version 0.7.0 lets the reviewer turn off what they don't use and checks an approval against what they read. Settings has a switch for each feature that can get in the way, from single-key shortcuts and folding to alerts and agents starting on their own, each on by default and saying what stays when it's off. With Approve picked, Finish review flags unviewed files in high-risk chapters and chapters marked viewed faster than anyone reads. An agent's draft comment carries how it confirmed the problem, which stays in BB. Agents read only their own review, a PR whose branch is in someone else's fork waits for the reviewer's click whoever opened it, and the hidden guide writer runs at the lowest permissions its provider allows.

## Distribution and operating limits

The current release is version **0.7.0**, for BB **0.45.0+**, Node **24+**, and plugin SDK **0.6.14+**. Reviewers need their own BB installation and GitHub authentication. It does not provide shared review workspaces or separate user accounts within one server.

Git and `gh` run on the BB server. Local review checkouts must exist there; a checkout only on another enrolled machine is unsupported. GitHub features currently support `github.com`. Account switching affects that server’s `gh` credentials, including other consumers; environment-token overrides must be cleared before switching saved accounts.

Metadata, patches, guides, and drafts reside in the installation’s plugin database. Review agents receive context through the configured provider. Sharing a BB server shares its credentials and plugin storage. See [README.md](README.md) for installation and operations, and [DESIGN.md](DESIGN.md) for the current interface system.

## Updates

The plugin uses BB’s native compatibility checks, installation, and rollback. Manual update controls live in Settings. Automatic updates are opt-in and wait for five idle minutes with no open review/Settings pages and no active work. Unsaved public drafts have per-tab recovery with their original review revision; private notes remain separate.
