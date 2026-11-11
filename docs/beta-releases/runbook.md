# Main canary runbook

Operator-only, after the disposable-BB rehearsal and separate approval for downtime and removal. Replace every `<PLACEHOLDER>` before running; commands run on the BB server. Never paste credentials into a thread, command argument or this file. [Plan](plan.md#6-implementation-and-release-plan) and [backup details](../operations.md#backups).

## One-time switch

1. **Freeze and record.** Freeze merges; confirm remote `main` is the accepted Phase 0 SHA. Turn **Update automatically when idle** off in CRW Settings. Save/close editors and stop guide, review and focus workers through BB; disabling the plugin does not stop independent threads. Record backend, ownership, review count, drafts and preferences for comparison.

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

   ```sh
   bb plugin disable code-review-workspace
   sqlite3 '<BB_DATA_DIR>/plugins/code-review-workspace/data.db' ".backup '<PRIVATE_RECOVERY_DIR>/data.db'"
   # For Postgres only: service credentials live in private libpq files, not arguments.
   PGSERVICEFILE='<PRIVATE_PGSERVICE_FILE>' PGPASSFILE='<PRIVATE_PGPASS_FILE>' \
     pg_dump --dbname='service=<PG_SERVICE>' --schema='<POSTGRES_SCHEMA>' \
     --format=custom --file='<PRIVATE_RECOVERY_DIR>/crw.dump'
   ```

   Do not copy an active SQLite WAL database with `cp`. Restore these backups into disposable targets and verify the expected data, secrets and ownership before continuing. Stop if the recovery bundle or measured restore time is unacceptable. Store the bundle privately off-server too.

3. **Remove, then install `@main`.** This intentionally deletes host settings, secrets and schedules. No automatic first-switch rollback exists. Proceed only after the backup gate and owner authorization. For install, do not pass `--yes`; check the resolved source it shows before confirming.

   ```sh
   # No confirmation prompt: this deletes settings and secrets immediately.
   bb plugin remove code-review-workspace
   bb plugin install git:github.com/AndrewBird81/bb-plugin-code-review-workspace@main
   ```

4. **Restore all six settings; backend last.** Use the saved effective values, including empty/default values. Restore `postgresPassword` through Settings' secret field, not shell arguments. Restore the required HTTP token offline from the private backup, or securely rotate it and update consumers. There is no bulk config import.

   ```sh
   bb plugin config code-review-workspace set postgresUrl '<SAVED_PASSWORD_FREE_POSTGRES_URL_OR_EMPTY>'
   bb plugin config code-review-workspace set postgresSchema '<SAVED_POSTGRES_SCHEMA>'
   bb plugin config code-review-workspace set postgresSsl '<SAVED_POSTGRES_SSL>'
   bb plugin config code-review-workspace set postgresCaPem '<SAVED_CA_PEM_OR_EMPTY>'
   # Confirm postgresPassword and any required token are restored before this last setting.
   bb plugin config code-review-workspace set storageBackend '<SAVED_STORAGE_BACKEND>'
   bb plugin reload code-review-workspace
   ```

   SQLite installation already runs migrations. Retained Postgres ownership keeps startup in maintenance until settings agree. **Do not run `bb review storage migrate`: source switching does not change backend ownership.**

5. **Verify before unfreezing.** Compare the resolved SHA with the accepted candidate; require `state: serving`, the original backend/owner, review count, drafts/preferences and working Postgres connectivity. Confirm auto-apply is still off. Start with focuses off, then perform the agreed smoke tests. Stop on missing data or ownership; never initialize a replacement store. Keep the recovery bundle after acceptance.

   ```sh
   bb plugin source code-review-workspace --json
   bb review storage status
   ```

## Recovery

1. **Contain a late or behavioral fault.** Save evidence, block posting, stop independent workers through BB, then disable CRW. Preserve current data for salvage.

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

   1. Preserve the migrated schema under a salvage name, using the original `postgresSchema` from the saved config:

      ```sql
      ALTER SCHEMA "<ORIGINAL_POSTGRES_SCHEMA>" RENAME TO "code_review_workspace_salvage_<DATE>";
      ```

   2. Restore the pre-change schema dump unchanged under its original name, using a restore operator able to restore its recorded ownership. Never use `--clean`. Verify the restored tables are owned by CRW's role, not the restore operator.

      ```sh
      PGSERVICEFILE='<PRIVATE_PGSERVICE_FILE>' PGPASSFILE='<PRIVATE_PGPASS_FILE>' \
        pg_restore --dbname='service=<PG_SERVICE>' --exit-on-error '<PRIVATE_RECOVERY_DIR>/crw.dump'
      ```

   3. After data compatibility is established, reinstall below, then restore settings (step 4), including the original `postgresSchema` and its database's `postgresUrl`, **before reloading**. `storage:owner` records only the backend; it stays `postgres`. Keep the salvage schema for later extraction; never point old code at it or rewind the shared CNPG cluster. Verify (step 5) against the restored data. Later edits may be lost.

   To return to stable update tracking, reinstall with `@^1.0.0` below. Until `v1.13.0` is tagged, it resolves to `v1.12.1`; check the resolved version and SHA against the recorded known-good source before confirming. Keep the recorded SHA for verification, not as the install selector. If the range offers an incompatible newer release, cancel; use an exact known-good tag only for deliberately **pinned** recovery. With an exact tag, `bb plugin update` reports `pinned`; escaping it needs another backed-up remove/install that deletes settings and secrets. Do not pass `--yes`.

   ```sh
   # No confirmation prompt: this deletes settings and secrets immediately.
   bb plugin remove code-review-workspace
   bb plugin install 'git:github.com/AndrewBird81/bb-plugin-code-review-workspace@^1.0.0'
   ```

Fetch/engine/build failure before activation leaves the previous install intact: repair `main` and retry. A later managed update's activation error may trigger BB's default 30-second local-snapshot rollback, but Postgres is outside it and some startup failures only report needs-configuration. A first remove/install has no previous registration to restore; a successful update's snapshot is cleaned up. Never bypass the schema guard or assume old code is safe on newer data; released 1.12.1 lacks the guard. Recovery time and acceptable data loss must come from rehearsal, not a promised SLA.
