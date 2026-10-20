# Running Code Review Workspace

Notes for whoever runs the BB server Code Review Workspace is installed on. The guide's [Updates](guide.md#updates) and [Data and access](guide.md#data-and-access) cover what a reviewer needs.

## Updates

- **Settings → Plugin updates** checks for a compatible release and offers **Update now**. **Update automatically when idle** is off by default; on, the plugin checks hourly after five idle minutes, and updates only with every Code Review Workspace and Settings page closed and no generation, save, or submission in progress. BB handles failed-install rollback.
- `bb plugin update code-review-workspace` also updates it. Close the plugin's pages first, since BB's external update command does not use the in-plugin activity guard.
- Installs from a Git range, such as `^1.0.0`, follow its compatible releases (1.x). Local directories and exact tags are pinned and do not receive automatic updates.
- Changing a local installation to a Git source is a separate migration: this BB version requires removing the old source first, which can clear plugin data. Do not remove an existing installation just to obtain updates; keep its data and arrange a backup/migration with the BB operator. Fresh installs from a Git range are ready for normal updates.
- An interrupted browser connection can leave an editing session protected. If the updater still asks you to close pages after they are all closed, save any work elsewhere and reload the plugin through BB. Editing sessions intentionally never expire while a laptop might still hold unsaved text.

## How often GitHub is read

- Reviews in Needs review and Waiting on author are read every two minutes, or every minute where GitHub's notifications can't be read.
- Reviews in Reviewed are read every 10 minutes, and Archive every 30.
- New PRs to track, under **Track reviews from GitHub**, are looked for every 5 minutes.
- A GitHub notification about a PR reads it sooner, and **Refresh** reads at once. The notifications are a read-only check: the plugin never marks them read.
- Reading GitHub costs about 6 GraphQL points per 10 PRs a pass, plus about 2 points to re-read the threads of an active review with an open thread of yours, every 10 minutes, out of the 5,000 an hour an account has. On a rate limit, reading pauses for 15 minutes.
- A failed GitHub read preserves saved state.

## Needs You delivery

- Needs You is optional. If it is disabled, missing, or restarting, Code Review Workspace keeps the guide successful and retries the same completion event once a minute for up to 24 hours while loaded.
- Restarting preserves queued outcomes.
- A newer generation supersedes the previous queued result; cancelled workers never ping.

## Storage and sharing

- Review metadata, patches, generated guides, drafts, and settings are in this BB installation's plugin database. `bb plugin remove code-review-workspace` can delete them.
- Reviews of PRs merged or closed for 30 days drop their stored diff to save space; opening one reads the diff from GitHub again.
- Git and `gh` run on the BB server, with its `gh` credentials. Switching the GitHub account in the plugin switches `gh` for everything on the server, other agents and terminals included.
- A shared BB server uses shared server credentials and plugin storage; it is not a multi-tenant review service. Each reviewer should use their own BB installation.

## Logs

`bb plugin logs code-review-workspace` shows the plugin's log, including why a guide failed and, after a move from Guided Review, "Brought in the reviews from guided-review".
