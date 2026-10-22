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

- Review metadata, patches, generated guides, drafts, and settings are in the plugin's database: SQLite, the plugin's `data.db` in this BB installation, by default, or Postgres (see [Storage backends](#storage-backends)). The plugin's BB settings and a few small key-value rows, `storage:owner` among them, stay in BB's own database either way. See [Removing the plugin](#removing-the-plugin) for what `bb plugin remove` deletes.
- Reviews of PRs merged or closed for 30 days drop their stored diff to save space; opening one reads the diff from GitHub again.
- Git and `gh` run on the BB server, with its `gh` credentials. Switching the GitHub account in the plugin switches `gh` for everything on the server, other agents and terminals included.
- A shared BB server uses shared server credentials and plugin storage; it is not a multi-tenant review service. Each reviewer should use their own BB installation.

## Storage backends

From 1.3.0 the reviews can be kept in Postgres instead of SQLite. Both hold the same tables and answer the same; nothing in the panel, the agents, or `bb review` differs.

- **SQLite**, the default: `data.db` in the plugin's data directory (`~/.bb/plugins/code-review-workspace/`), through BB's own SQLite. Nothing to set up.
- **Postgres**: the same tables in a schema of a Postgres database, reached over one connection from the BB server. Choose it to keep the reviews off the BB server's disk, in a database that's backed up with others. It was tested on Postgres 18, and rehearsed on BB 0.46.1.
- **Which one serves** depends on two things that must agree: the `storageBackend` setting, and the `storage:owner` marker in BB's key-value rows, which names the backend holding the reviews. An install from before 1.3.0 has no marker, which means SQLite. Only `bb review storage migrate` and `export-sqlite` change the marker, once their copy checks out. While the two disagree, the plugin is in [maintenance](#maintenance-mode); it never falls back to the other backend.
- **Storage settings apply when the plugin loads.** Changing one logs "Storage settings changed: they apply once the plugin reloads"; `bb plugin reload code-review-workspace` applies them.
- **Speed:** each store call is a round trip to Postgres. In the rehearsal, at about 1.3 ms a round trip, the heaviest call, opening a review with a 15.6 MB diff, took about 37 ms (17 ms on SQLite), and other calls 2–17 ms.

### Setting up Postgres

1. Make a login role with a SCRAM password (Postgres's default `password_encryption`; `require` signs in only with SCRAM), and a database it owns, or one it can create schemas in. The plugin holds one connection, and a `bb review storage` command one more while it runs, so allow at least 2:

   ```sql
   CREATE ROLE code_review_workspace LOGIN CONNECTION LIMIT 5 PASSWORD '…';
   CREATE DATABASE code_review_workspace OWNER code_review_workspace;
   ```

   The plugin makes its schema (`postgresSchema`) if it's missing, and its tables in it. A schema that exists already needs to be the role's, or one it can create tables in.
2. Set the [settings](#postgres-settings) on the BB server, `storageBackend` last. Read the password into a variable, so it stays out of your shell's history:

   ```sh
   bb plugin config code-review-workspace set postgresUrl postgres://code_review_workspace@db.example.internal:5432/code_review_workspace
   read -rs pw && bb plugin config code-review-workspace set postgresPassword -- "$pw"; unset pw
   bb plugin config code-review-workspace set storageBackend postgres
   ```

3. Run `bb plugin reload code-review-workspace`. The reviews are still in SQLite, so the plugin goes into maintenance, which stops every write.
4. Run `bb review storage migrate` from a terminal on the BB server. It copies the reviews, checks the copy, and marks Postgres as holding them.
5. Run `bb plugin reload code-review-workspace` again. `bb review storage status` says `state: serving`.

Take a [backup](#backups) of `data.db` first. `migrate` leaves `data.db` as it was, so it is the way back until the plugin writes to Postgres; see [Rolling back to SQLite](#rolling-back-to-sqlite).

### Postgres settings

| Setting | Default | What it is |
|---|---|---|
| `storageBackend` | `sqlite` | `sqlite` or `postgres`: where the reviews are kept. |
| `postgresUrl` | none | `postgres://user@host:port/database`. It takes **no password and no query parameters**: a URL with either is refused, and the message names the setting to use instead. `sslmode` and the like in a URL are refused rather than read, since pg would take a URL's `sslmode=require` as `verify-full`. PG* environment variables (`PGHOST`, `PGSSLMODE`, …) are never read. |
| `postgresPassword` | none | The role's password, kept as a BB secret. Needed with `postgres`. If the role's password changes, set it again and reload. |
| `postgresSchema` | `code_review_workspace` | The schema the tables are made in, created if it's missing. Two installs sharing a database need a schema each. |
| `postgresSsl` | `require` | `verify-full`, `require`, or `disable`; see [TLS](#tls). |
| `postgresCaPem` | none | PEM certificates that `verify-full` checks the server's certificate against; without it, Node's CAs. Refused with the other modes. |

No message or log line the plugin writes shows the URL or the password. The connection's `application_name` is `code-review-workspace`, and `code-review-workspace storage` for a storage command's own. Statements time out after 30 s, and a transaction left idle after 60 s; a connection attempt gives up after 10 s.

### TLS

| `postgresSsl` | Encryption | The server is proven by | The password goes |
|---|---|---|---|
| `verify-full` | TLS | its certificate, chaining to `postgresCaPem` (or Node's CAs) and naming the URL's host | only to that server. Channel binding is used when the server offers it, but not required, and any sign-in method the server asks for is answered. |
| `require` (default) | TLS, the certificate not checked | SCRAM-SHA-256-PLUS: the server proves it holds the role's SCRAM secret, bound to this TLS connection | nowhere: only a SCRAM-SHA-256-PLUS proof goes out. A server that asks for a cleartext or MD5 password, for SCRAM without channel binding, for a second sign-in, or lets the connection in without one, is refused before the plugin answers. |
| `disable` | none | the password exchange alone | SCRAM never sends the password, but everything else is in the clear, and a server asking for cleartext or MD5 gets the password or its hash. For local development only. |

- `require` behaves like libpq's `sslmode=require channel_binding=require`. It needs the role's password stored as SCRAM, not MD5, and Postgres 11 or later over TLS.
- `require` survives the server's CA changing and needs no certificate on the BB server. A man in the middle can't sign in or read the traffic, but one who skips the certificate check can collect a SCRAM proof and guess passwords against it offline, so give the role a long random password.
- `verify-full` breaks when the server's CA changes and `postgresCaPem` isn't updated; CloudNativePG, for one, renews its CA every 90 days.

### Single writer

One plugin instance writes to a schema at a time.

- The plugin takes a Postgres advisory lock for its schema when it opens its storage, and takes it again on each new connection before anything runs on it. Another BB using the same database and schema waits up to 30 s for it, then reports "Another Code Review Workspace holds the writer lock on Postgres schema …", and keeps trying.
- A reload hands over without overlap: the old instance closes its connection, and its lock, before the new one opens. For about half a second, until the new instance has opened its store, the panel's calls fail and a page loading then shows "Couldn’t open the review session. The plugin may be updating. Try again." On SQLite there is no such gap.
- A connection whose BB went silent is ended by the server's TCP keepalive after about 25 s, and its lock with it.

### Maintenance mode

In maintenance the plugin registers `bb review` and nothing else: no panel calls, agent tools, events, or background work, and agents get no tools. Only `bb review storage` answers; every other `bb review` command fails with the reason, and the panel can't open. `bb plugin list` shows the plugin as needs-configuration, with the reason:

- "…storage is set to Postgres, but its reviews are in SQLite. Run bb review storage migrate…", or set `storageBackend` back to `sqlite` and reload.
- "…storage is set to SQLite, but its reviews are in Postgres…": set `storageBackend` back to `postgres` and reload, or run `bb review storage export-sqlite --replace-data-db`.
- "…can't use Postgres: …": a Postgres setting is missing or refused. Fix it and reload.
- "…marked as kept in …, which this version doesn't know": a newer version moved the reviews; update the plugin.

The panel shows only "Couldn’t open the review session. The plugin may be updating. Try again."; `bb review storage status` says why.

On Postgres the plugin also starts with only `bb review storage` answering, while it opens its storage (`state: opening`): normally well under a second. If Postgres can't be reached, it keeps trying, after 1 s and then twice as long each time up to a minute, and serves once it gets through, with no reload. A wrong password, a refused TLS sign-in, a missing database or permission, or the writer lock still held is reported as needs-configuration at once; Postgres simply being out of reach only after a minute, so a BB that starts before its database doesn't need attention. **BB keeps a needs-configuration status until the next reload**, even once the plugin serves; the message says so.

### Moving the reviews: `bb review storage`

Run these on the BB server, from a terminal. `migrate` and `export-sqlite` refuse to run from a BB thread (when `BB_THREAD_ID` is set), so an agent can't start them on its own; `status` and `verify` answer anywhere. One storage command runs at a time, and a reload or a dropped CLI connection stops one before it commits anything.

- **`bb review storage status`**: the configured backend (`storageBackend`), the one holding the reviews (`storage:owner`), the state (`serving`, `opening`, or `maintenance`), and what's wrong, if anything.
- **`bb review storage verify`**: compares every table's rows, row counts, and each next id in `data.db` and in Postgres, and prints a line per table, `same` or `DIFFERENT`. It exits 0 when everything is the same and 1 otherwise, and changes nothing. It runs in any state; while the plugin serves, it says the serving side may have moved on, and after a move it differs as soon as the plugin writes.
- **`bb review storage migrate`**: in maintenance, with `storageBackend` set to `postgres` and the reviews in SQLite. It brings `data.db` up to date as a load would, takes the writer lock, and copies the reviews to Postgres in one transaction, then compares every table on both sides before it commits, and marks the owner `postgres` after. It prints a line per table with its rows and time. Before copying, it checks, and reports together:
  - text with NUL bytes, or bytes that aren't UTF-8, which Postgres can't hold;
  - integers beyond ±2^53, or a value of the wrong type for its column;
  - SQLite's or Postgres's tables from another version of the plugin;
  - a schema that already holds reviews.

  Nothing is written if any check fails, or if anything fails mid-copy ("… Nothing was changed."): fix what it lists and run it again. If Postgres already holds exactly SQLite's reviews, as when the copy committed but the marker couldn't be written, it only marks the owner: "Postgres already holds an identical, checked copy; only the owner was switched". A schema holding other reviews is refused, with the tables that differ; drop its tables or choose a new `postgresSchema`. There is no overwrite option.
- **`bb review storage export-sqlite`**: in maintenance, with the reviews in Postgres. It writes a new `data-export-<UTC time>.db` beside `data.db`, a copy of `data.db` whose reviews are Postgres's, checked against Postgres, and changes nothing else. A name already taken gets `-2`, `-3`, ….
  - **`--replace-data-db`**, with `storageBackend` set to `sqlite`, then backs `data.db` up to `data-backup-<UTC time>.db`, replaces its reviews with the copy's in one transaction, checked before it commits, and marks the owner `sqlite`.
- After `migrate` or `export-sqlite --replace-data-db`, reload the plugin to serve from the other backend; the command says so.

On the rehearsal's copy of a production `data.db` (47 reviews, 864 rows, 50 MB), `migrate` took about 1.1 s, `export-sqlite --replace-data-db` 0.9 s, and `verify` 0.3 s; BB's memory rose by about 150 MB during `migrate` and fell back after.

### Backups

- **SQLite:** copy `data.db` with SQLite's backup API or `VACUUM INTO`, never with `cp` while BB runs, which misses what is still in its write-ahead log. `bb plugin update` also snapshots `data.db`, and restores it when an update fails within its 30 s check.
- **Postgres:** back up the database as you do others, or the plugin's schema alone, with `pg_dump --schema=code_review_workspace`. BB's update snapshot doesn't cover Postgres.
- **Either way,** the `storage:owner` marker and the storage settings are in BB's own database, with BB's backups.
- `export-sqlite` and its `--replace-data-db` backup leave files about the size of `data.db` in the plugin's data directory, readable as the BB process's umask allows, and nothing deletes them. They hold every review: delete them, or `chmod 600` them, once they're no longer needed.

### Rolling back to SQLite

```sh
bb plugin config code-review-workspace set storageBackend sqlite
bb plugin reload code-review-workspace          # maintenance: the reviews are in Postgres
bb review storage export-sqlite --replace-data-db
bb plugin reload code-review-workspace          # serving from SQLite, with what was written on Postgres
```

- **Export before you go back.** `data.db` stays as it was at the move to Postgres. Setting `storageBackend` to `sqlite` alone doesn't serve it, since the owner is still Postgres; but 1.2.0 or older reads `data.db` without asking, and would silently serve the reviews as they were at the move.
- **1.3.0 adds no SQLite migrations,** so 1.2.0 reads an exported `data.db` as its own. BB has no downgrade in place for a Git install: remove the plugin (which deletes its settings and password) and install `@v1.2.0`, which pins it. To return, remove it and install `@^1.0.0` again, and set the storage settings again.
- **Postgres keeps its copy** after an export. Moving to Postgres again needs a schema without reviews, or one holding exactly SQLite's: drop the old schema's tables, or set a new `postgresSchema`.
- A table whose `sqlite_sequence` had no row comes back from Postgres with a row holding its last id. SQLite hands out the same next id either way.

### When Postgres misbehaves

| What happens | What the plugin does |
|---|---|
| Postgres restarts, crashes, or fails over while the plugin serves | It logs "Lost the connection to Postgres: …". The call in flight fails, and nothing is retried, since a write might have committed. The next call connects again, and the plugin serves again by itself. |
| The network to Postgres drops packets | A call in flight fails after 35 s ("Query read timeout"), and later calls fail on connecting. It recovers by itself. |
| Postgres can't be reached at a reload or BB's start | Only `bb review storage` answers until it can; see [Maintenance mode](#maintenance-mode). Reload to try at once. |
| Postgres dies during `migrate` or `export-sqlite` | "… Nothing was changed.": the copy is rolled back or deleted, and the owner stays. Run it again once Postgres is back. |

### Removing the plugin

`bb plugin remove code-review-workspace` never touches Postgres: the schema, its tables, the role, and the database stay until you drop them. On BB 0.46, removing also keeps `data.db`, the export and backup files beside it, and the key-value rows, `storage:owner` included, but deletes the plugin's settings, the Postgres password among them. Installed again, with the reviews still marked as in Postgres, the plugin starts in maintenance until the storage settings are set again.

## Logs

`bb plugin logs code-review-workspace` shows the plugin's log, including why a guide failed and, after a move from Guided Review, "Brought in the reviews from guided-review".

On Postgres it also shows "Lost the connection to Postgres: …" and "Could not open Code Review Workspace's Postgres storage: …", and each `bb review storage` command's progress lines.
