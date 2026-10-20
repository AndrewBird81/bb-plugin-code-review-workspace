For reviewers who need to understand a change before they approve it, often one an agent wrote. The agents read, draft, and explain; you decide what posts.

## What you get

- **A guide to the change.** An agent writes the PR's intent and its chapters in reading order, each with a risk level. Risky chapters list what to verify, and **Start here** points to the one to three lines most likely to hide a defect.
- **Requirements, checked.** What the PR's description and linked issues ask for, each marked covered, partial, missing, or unclear, with evidence.
- **A drafted review you edit.** The review agent drafts line comments with a severity (Blocking, Should fix, Question, or Nit), a summary, and a suggested verdict. Each draft says how the agent confirmed the problem.
- **Ask agent.** Ask the review agent about the whole change, a line, a selection, or a failing check.
- **Finish review.** The summary, your verdict, and exactly what will be posted. Before you approve, it flags blocking comments, unviewed files in high-risk chapters, chapters read faster than your set pace, and files the agent didn't read.

## Whose turn and re-review

- **All reviews** sorts your reviews into Needs review, Waiting on author, Reviewed, and Archive. A push alone never makes a review your turn; a re-request, a question for you, or your feedback being handled does.
- PRs that request your review join the list from GitHub.
- After new commits, **Since your review** shows only what changed since the commit you reviewed. The review agent checks each of your earlier threads and drafts replies for you to send.
- Snooze, pin, and archive reviews. Alerts go to the separate Needs You plugin, if you install it.

## Reading the diff

- Lockfiles, generated files, and huge diffs start folded. New files show as files, and long runs of deleted lines fold.
- File chips show code owners, tests that lose assertions or get skipped, lockfiles that add packages or download from another host, and hidden bidirectional Unicode.
- CI failure annotations show under their lines.

## Local changes and agent threads

- Run `bb review` in a BB thread to review a local branch or range from a checkout on the BB server.
- On your own PR or a local review, Finish review sends your comments back to the thread that made the change, or to a new thread.
- Agents in your other threads can add draft comments with `bb review comment`. Nothing they do posts to GitHub.

## Trust

- Nothing posts to GitHub until you click **Submit**, **Send reply**, or **Resolve**. The agents change only the local draft.
- Agents start on their own only on PRs from the repository's members and collaborators, and not on a branch in someone else's fork. For other PRs, one click runs them.
- Text from the PR reaches the agents fenced as untrusted data, and the repo's instruction files are read from the PR's base, never its head.
- Every feature that can get in the way has a switch in Settings.

## Requirements and costs

- BB 0.45 or later, on Node 24 or later.
- `git` and GitHub CLI (`gh`) on the BB server, signed in to github.com. GitHub features support github.com only.
- A BB agent provider. Guides, reviews, and re-review checks use its usage allowance.
- At least one BB project.
- Local reviews need their checkout on the BB server.
- Each reviewer needs their own BB installation: a shared BB server shares its GitHub credentials and saved reviews.

## More

- Full guide, troubleshooting, and settings: [README](https://github.com/AndrewBird81/bb-plugin-code-review-workspace#readme).
- Formerly Guided Review. Moving over copies your reviews, drafts, and settings: [Moving from Guided Review](https://github.com/AndrewBird81/bb-plugin-code-review-workspace#moving-from-guided-review).
- Maintained by Andrew Bird. It began as a fork of [Pritam Sharma's Guided Review](https://github.com/notpritam/bb-plugin-guided-review).
