# Main canary runbook

Operator-only, after the disposable-BB rehearsal and separate approval for downtime and removal. Replace every `<PLACEHOLDER>` before running; commands run on the BB server. Never paste credentials into a thread, command argument or this file. [Plan](plan.md#6-implementation-and-release-plan) and [backup details](../operations.md#backups).

## One-time switch

1. **Freeze and record.** Freeze merges; confirm remote `main` is the accepted Phase 0 SHA. Turn **Settings → Plugin updates → Update automatically when idle** off and save private evidence that it is unchecked. Save/close editors and stop guide, review and focus workers through BB; disabling the plugin does not stop independent threads. Record backend, ownership, review count, drafts and preferences for comparison. The flag is read through the panel RPC's [`getReleaseStatus` → `automatic`](../../src/plugin-updates.ts), not a `bb review` CLI command; check it in Settings again in step 5. The rehearsal did not verify auto-apply.

   ```sh
   umask 077
   mkdir -p '<PRIVATE_RECOVERY_DIR>'
   bb --version > '<PRIVATE_RECOVERY_DIR>/bb-version.txt'
   bb plugin source code-review-workspace --json > '<PRIVATE_RECOVERY_DIR>/source.json'
   bb plugin list --json > '<PRIVATE_RECOVERY_DIR>/plugins.json'
   bb plugin config code-review-workspace --json > '<PRIVATE_RECOVERY_DIR>/config.json'
   bb review storage status > '<PRIVATE_RECOVERY_DIR>/storage-status.txt'
   git ls-remote https://github.com/AndrewBird81/bb-plugin-code-review-workspace.git refs/heads/main
   ```

2. **Disable, back up, prove restore.** Verify the password is recoverable from the secret manager. Config JSON contains only secret presence, not values. Retain the HTTP token privately if consumers require it. Take the operator's consistent BB-state/KV backup (including `storage:owner`) and a restricted/encrypted secret backup; do not enable server-export experiments. Leave `data.db` and the ownership marker in place.

   Proceed only after confirming the password and required token are recoverable and independent workers are stopped.

   ```sh
   bb plugin disable code-review-workspace
   ```

   After disable succeeds, take the backups:

   ```sh
   umask 077
   sqlite3 '<BB_DATA_DIR>/bb.db' ".backup '<PRIVATE_RECOVERY_DIR>/bb.db'"
   cp -R '<BB_DATA_DIR>/plugins/code-review-workspace/secrets' '<PRIVATE_RECOVERY_DIR>/secrets'
   chmod -R go-rwx '<PRIVATE_RECOVERY_DIR>/secrets'
   find '<PRIVATE_RECOVERY_DIR>/secrets' -type f -exec chmod 600 {} \;
   sqlite3 '<BB_DATA_DIR>/plugins/code-review-workspace/data.db' ".backup '<PRIVATE_RECOVERY_DIR>/data.db'"
   chmod 600 '<PRIVATE_RECOVERY_DIR>/bb.db' '<PRIVATE_RECOVERY_DIR>/data.db'
   # For Postgres only: service credentials live in private libpq files, not arguments.
   PGSERVICEFILE='<PRIVATE_PGSERVICE_FILE>' PGPASSFILE='<PRIVATE_PGPASS_FILE>' \
     pg_dump --dbname='service=<PG_SERVICE>' --schema='<POSTGRES_SCHEMA>' \
     --format=custom --file='<PRIVATE_RECOVERY_DIR>/crw.dump'
   chmod 600 '<PRIVATE_RECOVERY_DIR>/crw.dump'
   ```

   For the disposable Postgres restore proof, confirm `<SCRATCH_DB>` is a new, unused database name, never CRW's database. Restore only if creation succeeds:

   ```sh
   PGSERVICEFILE='<PRIVATE_PGSERVICE_FILE>' PGPASSFILE='<PRIVATE_PGPASS_FILE>' \
     createdb --maintenance-db='service=<PG_ADMIN_SERVICE>' '<SCRATCH_DB>' &&
   PGSERVICEFILE='<PRIVATE_PGSERVICE_FILE>' PGPASSFILE='<PRIVATE_PGPASS_FILE>' \
     pg_restore --dbname='service=<PG_ADMIN_SERVICE> dbname=<SCRATCH_DB>' \
     --exit-on-error '<PRIVATE_RECOVERY_DIR>/crw.dump'
   ```

   Verify the restored tables, their CRW role ownership and the review count against the recorded baseline. These queries are read-only; stop if restore failed or any result differs.

   ```sh
   PGSERVICEFILE='<PRIVATE_PGSERVICE_FILE>' PGPASSFILE='<PRIVATE_PGPASS_FILE>' \
     psql --dbname='service=<PG_ADMIN_SERVICE> dbname=<SCRATCH_DB>' -X --set=ON_ERROR_STOP=1 \
     --command="SELECT schemaname, tablename, tableowner FROM pg_catalog.pg_tables WHERE schemaname = '<POSTGRES_SCHEMA>' ORDER BY tablename;" \
     --command='SELECT count(*) AS review_count FROM "<POSTGRES_SCHEMA>".reviews;'
   ```

   Only after the verification passes, and only on the scratch database you just created.

   ```sh
   PGSERVICEFILE='<PRIVATE_PGSERVICE_FILE>' PGPASSFILE='<PRIVATE_PGPASS_FILE>' \
     dropdb --maintenance-db='service=<PG_ADMIN_SERVICE>' '<SCRATCH_DB>'
   ```

   The BB 0.49.0 rehearsal verified the `bb.db` backup plus private secrets copy; without step 2's own `umask`, its dump and `data.db` backup were 0644. Do not copy an active SQLite WAL database with `cp`. Restore these backups into disposable targets and verify the expected data, secrets and ownership before continuing. Stop if the recovery bundle or measured restore time is unacceptable. Store the bundle privately off-server too.

3. **Remove, then install `@main`.** This intentionally deletes host settings, secrets and schedules. No automatic first-switch rollback exists. Proceed only after the backup gate and owner authorization. Run install in an interactive terminal; do not pass `--yes`. The BB 0.49.0 rehearsal verified that without a TTY it refuses and suggests `--yes`; the prompt shows only the requested selector, not the resolved SHA. Verify the SHA afterwards with `source --json` below and compare it with the accepted candidate before restoring settings.

   Removal has no confirmation prompt and deletes settings and secrets immediately. Proceed only after the backup/restore checks pass and the owner authorizes removal.

   ```sh
   bb plugin remove code-review-workspace
   ```

   After removal succeeds, install and inspect the source:

   ```sh
   bb plugin install git:github.com/AndrewBird81/bb-plugin-code-review-workspace@main
   bb plugin source code-review-workspace --json
   ```

   Before settings are restored, `needs-configuration (…storage is set to SQLite, but its reviews are in Postgres…)` is expected for retained Postgres ownership; the rehearsal verified this.

4. **Restore all six settings; backend last.** Use the saved effective values, including empty/default values. Restore `postgresPassword` through Settings' secret field, not shell arguments. Restore the required HTTP token offline from the private backup, or securely rotate it and update consumers. There is no bulk config import.

   ```sh
   bb plugin config code-review-workspace set postgresUrl '<SAVED_PASSWORD_FREE_POSTGRES_URL_OR_EMPTY>'
   bb plugin config code-review-workspace set postgresSchema '<SAVED_POSTGRES_SCHEMA>'
   bb plugin config code-review-workspace set postgresSsl '<SAVED_POSTGRES_SSL>'
   bb plugin config code-review-workspace set postgresCaPem -- '<SAVED_CA_PEM_OR_EMPTY>'
   ```

   Confirm `postgresPassword` and any required token are restored before applying the backend setting and reloading:

   ```sh
   bb plugin config code-review-workspace set storageBackend '<SAVED_STORAGE_BACKEND>'
   bb plugin reload code-review-workspace
   ```

   The rehearsal's PEM command failed with `unknown option '-----BEGIN CERTIFICATE-----'`; `--` ends option parsing, as in [the password command](../operations.md#setting-up-postgres). SQLite installation already runs migrations. Retained Postgres ownership keeps startup in maintenance until settings agree. **Do not run `bb review storage migrate`: source switching does not change backend ownership.**

5. **Verify before unfreezing.** Compare the resolved SHA with the accepted candidate; require `state: serving`, the original backend/owner, review count, drafts/preferences and working Postgres connectivity. Confirm **Settings → Plugin updates → Update automatically when idle** is still unchecked. Verify serving only with `bb review storage status`: the rehearsal found that `bb plugin reload` and `bb plugin list` report `running` even while the newer-schema guard refuses to open storage. Start with focuses off, then perform the agreed smoke tests. Stop on missing data or ownership; never initialize a replacement store. Keep the recovery bundle after acceptance.

   ```sh
   bb plugin source code-review-workspace --json
   bb review storage status
   ```

## Recovery

1. **Contain a late or behavioral fault.** Save evidence, block posting and stop independent workers through BB. Only after confirming these checks, disable CRW. Preserve current data for salvage.

   ```sh
   bb plugin disable code-review-workspace
   ```

2. **Prefer forward repair if data is intact.** Prepare and test a repair or selective revert on `main` retaining migrations 40–42, the startup guard and compatible storage behavior. Freeze merges, record the repair SHA, then:

   ```sh
   bb plugin update code-review-workspace
   bb plugin enable code-review-workspace
   bb plugin source code-review-workspace --json
   bb review storage status
   ```

   Repeat switch step 5. Enabling after a disabled update is manual recovery, not a fresh protected activation window.

3. **Restore for corruption, a failed first switch, or return to pre-focus code.** Keep CRW disabled and workers stopped. Restore the consistent pre-change SQLite/BB-state bundle using the rehearsed operator procedure. For Postgres, `pg_restore` cannot rename the schema in the dump; recover in this order:

   1. Check the target database's schemas using the database in the saved `postgresUrl` as `<SAVED_POSTGRES_DATABASE>` and the saved `postgresSchema` as `<ORIGINAL_POSTGRES_SCHEMA>`:

      ```sh
      PGSERVICEFILE='<PRIVATE_PGSERVICE_FILE>' PGPASSFILE='<PRIVATE_PGPASS_FILE>' \
        psql --dbname='service=<PG_ADMIN_SERVICE> dbname=<SAVED_POSTGRES_DATABASE>' -X --set=ON_ERROR_STOP=1 \
        --command='SELECT nspname, pg_catalog.pg_get_userbyid(nspowner) AS owner FROM pg_catalog.pg_namespace ORDER BY nspname;'
      ```

      Only after confirming the database is CRW's, the original schema exists, the salvage name is unused, and CRW and its workers remain stopped, preserve the migrated schema. Run this SQL in that same database:

      ```sql
      ALTER SCHEMA "<ORIGINAL_POSTGRES_SCHEMA>" RENAME TO "code_review_workspace_salvage_<DATE>";
      ```

   2. Repeat the read-only schema query above. Only after confirming the rename succeeded, the original schema name is absent, and the recovery bundle passed the restore proof, restore the pre-change schema dump unchanged under its original name, using a separate `<PG_ADMIN_SERVICE>`. `<SAVED_POSTGRES_DATABASE>` is the database in the saved `postgresUrl`. The rehearsal restored as a superuser and verified the tables were owned by CRW's role; restoring as CRW's own role is untested. Never use `--clean`. Verify the restored tables are owned by CRW's role, not the restore operator.

      ```sh
      PGSERVICEFILE='<PRIVATE_PGSERVICE_FILE>' PGPASSFILE='<PRIVATE_PGPASS_FILE>' \
        pg_restore --dbname='service=<PG_ADMIN_SERVICE> dbname=<SAVED_POSTGRES_DATABASE>' --exit-on-error '<PRIVATE_RECOVERY_DIR>/crw.dump'
      ```

   3. After data compatibility is established, reinstall below, then restore settings (step 4), including the original `postgresSchema` and its database's `postgresUrl`, **before reloading**. `storage:owner` records only the backend; it stays `postgres`. Keep the salvage schema for later extraction; never point old code at it or rewind the shared CNPG cluster. Verify (step 5) against the restored data. Later edits may be lost.

   To return to stable update tracking, reinstall with `@^1.0.0` below. The rehearsal resolved it to `v1.12.1` (`3d40c55d9764`). Before removal, inspect `git ls-remote --tags` below: confirm `v1.12.1` is still the highest matching stable tag and its commit matches the recorded known-good source (use the peeled `^{}` ref for an annotated tag). Keep the recorded SHA for verification, not as the install selector. If the tags indicate an incompatible newer release, stop before removal; use an exact known-good tag only for deliberately **pinned** recovery. With an exact tag, `bb plugin update` reports `pinned`; escaping it needs another backed-up remove/install that deletes settings and secrets. Run install in an interactive terminal without `--yes`; its prompt shows only the selector. Verify the resolved version and SHA afterwards, before restoring settings. The same temporary Postgres `needs-configuration` state from switch step 3 is expected.

   ```sh
   git ls-remote --tags https://github.com/AndrewBird81/bb-plugin-code-review-workspace.git
   ```

   Stop unless the tags pass the known-good check above and data compatibility and the backup/restore checks pass. Only with owner authorization, remove the plugin; there is no confirmation prompt, and settings and secrets are deleted immediately.

   ```sh
   bb plugin remove code-review-workspace
   ```

   After removal succeeds, install and inspect the source:

   ```sh
   bb plugin install 'git:github.com/AndrewBird81/bb-plugin-code-review-workspace@^1.0.0'
   bb plugin source code-review-workspace --json
   ```

Fetch/engine/build failure before activation leaves the previous install intact: repair `main` and retry. A later managed update's activation error may trigger BB's default 30-second local-snapshot rollback, but Postgres is outside it and some startup failures only report needs-configuration. A first remove/install has no previous registration to restore; a successful update's snapshot is cleaned up. Never bypass the schema guard or assume old code is safe on newer data; released 1.12.1 lacks the guard. Recovery time and acceptable data loss must come from rehearsal, not a promised SLA.
