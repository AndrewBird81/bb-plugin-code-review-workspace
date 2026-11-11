# Beta releases

## Verdict and recommendation

- **Feasible with changes.** Publish immutable prerelease tags; test the normal CRW identity on an **isolated BB instance and isolated data**. No bb-core change is needed for this approach. A Settings switch that replaces this owner's existing managed installation while preserving config **does require bb-core support**. [H1] [H2]
- **Recommended:** a fresh beta BB tracking one prerelease train, initially `>=1.13.0-beta.1 <1.13.0`; leave the existing stable installation untouched. This uses BB's updater, avoids maintaining two plugin identities, and keeps migrations away from production. The range admits later `1.13.0-beta.N`, not GA or the next train. [H3] [E5]
- Owner decision pending: isolated BB versus testing inside the existing BB. Asked parent `thr_p9rzn9chww`; do not provision either during this research.

## Evidence and limits

- **[V] Verified by read-only commands/computation; [R] read source/docs, not live-tested.** Future work below is a proposal, not completed verification.
- **[V] Baseline:** `git rev-parse HEAD` → `927211ad37bbc5cda16b4f672c7e3dcbf9722bd4`. Focus phases 0–4 are merged: `git log --oneline v1.12.1..HEAD` names PRs #14–18. `package.json:2–8,34` declares CRW `1.12.1`, `engines.bb >=0.48.0`, SDK floor `>=0.6.79`, and SDK development pin `0.6.104`.
- **[V] Version correction:** `bb --version` and `bb updates status --json` report **BB app 0.49.0**. `bb plugin types --check` reports `pin is 0.6.104, host is 0.6.132` and stale shim-package pins. **0.6.132 is the host SDK, not the BB app version.** Matching upstream release source: [BB desktop 0.49.0][host], whose [SDK manifest][sdk-version] is `0.6.132`.
- **[R] Deployment intent, not live health:** GitOps checkout `/Users/andrew/src/argo-cd` at `a46c7ff5eb56e4bf2c51a1eb6d3f2cf872bc15d5`: `postgres-ha/code-review-workspace-database.yaml:1–14` assigns CRW's database to CNPG `postgres-ha`; `scheduled-backup.yaml:1–22` enables daily Barman backups; `objectstore.yaml:7–24` declares 30-day retention and WAL archiving. No cluster, backup-success, restore, live config, secret value, or production database was inspected.
- **Not run:** plugin install/remove/update/reload/configuration, a live migration/downgrade, full CRW tests/build, publishing, tagging, or pushing. Only this document changes.

## 1. Shipping and updating today

- **[V/R] Git source releases:** local tags include `v1.12.1`; its commit is `3d40c55d9764958655cb741a544b0a5b8a20b107`. `gh release view v1.12.1 --repo AndrewBird81/bb-plugin-code-review-workspace --json tagName,isPrerelease,assets,url` reports `isPrerelease:false`, `assets:[]`, and [the GitHub release][crw-release]. `CHANGELOG.md:3–11` records 1.12.1/1.12.0 and update/rollback notes. BB resolves **Git tags**, not GitHub release assets or the release's prerelease checkbox. [H3]
- **[V/R] No release automation in the audited tree:** `git ls-tree -r --name-only HEAD` contains no `.github/workflows` or release script; `package.json:63–68` has test/typecheck/lint/build/check only. GitHub Actions still lists a `CI` workflow; its two recorded runs are PR runs. The [last successful run's definition][historical-ci] only installs dependencies, typechecks and tests, with `contents: read`; it does not publish. Existing tag/release creation is observable; an automated publisher is **not established**.
- **[V] Discovery:** `bb plugin search code-review-workspace --json` reports marketplace `bb-community` and source `git:https://github.com/AndrewBird81/bb-plugin-code-review-workspace.git@^1.9.0 (tags vX.Y.Z)`. This owner's `bb plugin source code-review-workspace --json` instead records `git:github.com/AndrewBird81/bb-plugin-code-review-workspace@^1.0.0`, resolved `v1.12.1 (3d40c55d9764)`. A catalog is discovery metadata, not a release artifact; installed sources retain their own selector. [H3]
- **[R] Install:** the documented command uses `@^1.0.0` (`README.md:202–206`). Git installs fetch source, install production dependencies without lifecycle scripts, and build declared bundles; `dist/` is not the release payload (`docs/development.md:22–24`; `bb guide plugins`, “Updates and pinning”). No npm publishing pipeline was found.
- **[V/R] Two update policies:** `bb guide plugins` says BB checks every six hours, offers manual updates, and never applies them automatically. **CRW itself can auto-update:** default off, hourly checks after five idle minutes, blocked by open views or ongoing work; it calls the host's `checkUpdates`/`applyUpdate` (`src/plugin-updates.ts:20–39,52–102`; `docs/operations.md:5–12`). The external CLI bypasses CRW's idle guard. Neither UI can currently change the recorded source selector. [H2]

## 2. What this host supports

- **[V/R] Supported selectors, not named release channels:** `bb plugin install --help` accepts `git:<url>[@<ref|semver-range>]`, npm versions and paths. `bb guide plugins`, “Updates and pinning”/“Git semver ranges”, documents exact Git tags/commits and npm versions as pinned; branches/default branches, Git ranges and npm dist-tags/ranges track updates. Stable Git ranges exclude prereleases. Tags are checked against their recorded commits; never move a published tag. [H3]
- **[V/R] The reinstall problem is real, but not universal:** managed reinstall/source replacement is refused. BB source throws `plugin id "${pluginId}" is already installed from ${existing.source}; remove it first`; matching managed-source reinstall is refused too. **Only direct path → direct path relocation is exempt** and keeps settings/secrets/schedules. Managed Git → path is not that exemption. `bb plugin remove --help` explicitly deletes settings, secrets and schedules, including CRW's Postgres password. [H1]
- **[V/R] Missing managed-source replacement:** `bb plugin update --help` exposes only id/`--all`, not a source, ref, version or downgrade. Current SDK `applyUpdate({ pluginId })`/`checkUpdates` have no channel or candidate argument; install still hits the identity checks. [H1] [H2]
- **Boundary:** CRW can publish beta tags, show instructions/version warnings, gate activity, or run under another id. It cannot implement **supported, config-preserving managed-source retargeting** with the present API. Full-trust code could edit host internals or remove/reinstall itself, but that is an unsafe replacement installer, not a suitable design. A proper Settings opt-in needs a bb-core source-replacement/selector API and CLI first. [H1] [H2]
- **[R] Existing developer escape hatch:** a plugin already installed from a local path can change code there and reload without deleting config (`bb guide plugins`). Use a durable checkout, not an ephemeral worktree. This does not convert this owner's Git install, and does not undo migrations. [H1]

## 3. Options: safety / effort / owner action

- **(d) Isolated beta BB, same id — recommended.** Highest production isolation; low CRW effort, moderate one-time operator setup. New BB data directory/endpoint and machine enrollment; private test project and checkout; SQLite initially, then disposable Postgres. Install once with the beta-train range, then use ordinary updates. Stable stays installed with its config. A same-machine BB is safe only if its data, credentials and projects are genuinely isolated; database isolation alone does not isolate agents/GitHub writes. Existing tests already target isolated BB (`docs/development.md:44–60`; `docs/operations.md:39–44`).
- **(a) Settings opt-in + beta tag/channel.** Convenient long-term UX, **high cross-repo effort**: source selector belongs to BB, not a CRW preference. Requires bb-core prepare/confirm/replace API, retained config and local snapshot, explicit downgrade semantics, then CRW Settings integration using its activity guard. Beta opt-in and auto-apply must remain separate, both off by default. A `beta` GitHub release label alone cannot implement selection or database recovery. [H1] [H2] [H3]
- **(b) Separate `code-review-workspace-beta` id alongside stable.** Feasible in CRW, medium/high maintenance; owner installs/configures a second plugin. Package name determines id [H7]; BB routes/storage/settings are namespaced (`bb guide plugins`, “Plugin commands”). Relative `review` paths can coexist as `/plugins/<id>/review/...` (`src/review-command.ts:74`; `lib/review-session.tsx:8–24`). But merely renaming the package is insufficient: distinguish `bb review`/skills (`server.ts:97–101,374–378`), hardcoded icon ids (`app.tsx:74,85,96`), draft-recovery keys (`lib/draft-recovery.ts:15`) and notification identities (`src/completion-notifications.ts:28,102–107`); avoid duplicate overlays/thread actions. **Separate SQLite is automatic; Postgres is not:** default schema is still `code_review_workspace`, so require a beta database/schema and restricted role. Same-schema writers contend on the same lock (`src/storage.ts:25–28`; `src/db/pg.ts:400–409`). Never share writable review data across identities.
- **(c) Exact prerelease/ref over stable, retaining config.** Fresh install supported, **replacement of this managed install unsupported**. Needs the same bb-core change as (a). Owner must not remove/reinstall or edit BB's registration database. If already path-installed, checkout/build/reload preserves config, but rollback remains a data-compatibility operation. [H1] [H2]
- **Other shortcuts rejected:** a moving `beta` branch loses immutable release selection; a bare repository URL tracks unreleased default-branch code. Shipping stable-numbered code with a feature toggle still ships beta startup/migrations to everyone; focuses-off does not prevent migration (`server.ts:123–141`). Use explicit prerelease tags, not those substitutes. [H3]

## 4. Data safety and downgrade policy

- **[V/R] Focuses schema delta:** both backends grow from **40 to 43 migrations**, ids **40–42**: `focus_threads`, `focus_findings`, `review_preferences.focuses`. Read-only array comparison against `v1.12.1` verified the first 40 statement strings are unchanged. SQL changes are additive (`src/store.ts:803–820`; `src/db/pg-migrations.ts:86–95`), but additive SQL alone does not prove behavioral downgrade compatibility.
- **[R] Migration timing:** SQLite migrates while opening the Store, before serving; Postgres locks its schema's writer, checks the migration ledger exists, then migrates in its storage service (`server.ts:123–141`). SQLite delegates to `bb.storage.migrate`; Postgres applies missing statements in one transaction under an advisory lock and rejects changed hashes at known indexes (`src/store.ts:817–825`; `src/db/pg-migrations.ts:105–131`). No down migrations exist in either list.
- **[V/R] No general “newer schema” startup guard:** both migration runners iterate only their known statements; extra applied ids do not fail startup. [H4] An in-memory execution of the **extracted SDK 0.6.132 SQLite helper** accepted an older one-statement list after applying a two-statement list; ledger rows stayed at 2. This verifies the helper, not a live CRW downgrade. Postgres behavior was read, not executed (`src/db/pg-migrations.ts:118–129`).
- **[R] A partial guard already exists, only for storage copying:** `src/storage-copy.ts:145–172` rejects unknown/newer migration ids. It is not called on normal Store startup. Focus preferences deliberately occupy a separate column; `src/focus-groundwork.test.ts:51–64` simulates an old settings save preserving it. That test was read, not run, and does not certify older runtime behavior, draft rewrites, deletion/merge operations or running focus threads.
- **Rollback answer:** do **not** promise beta → `1.12.1` on the same modified database. It may open, but has no guard and no certified downgrade behavior. Recommended rollback is stop beta work and restore its **pre-beta isolated snapshot**, or discard the beta environment; stable production never moved. Preserve/export wanted beta drafts before reset; post-snapshot changes are lost. No automatic beta → stable data merge.
- **Required policy:** append-only migration history **and** additive/backward-compatible schema and serialized-data changes throughout a beta train. Add startup guards on both backends before migrations/Store writes: reject unknown applied ids and changed known hashes, with an actionable version/restore message. Missing trailing migrations remain normal upgrades. Test both paths with future ledgers. **A guard added now cannot protect the already-released 1.12.1**; isolated data is mandatory for this first train.
- **Snapshot boundary:** BB's managed update snapshots local `data.db`, secrets and host-side plugin state, and rolls back activation errors during its 30-second check; **Postgres is outside it**, and later correctness bugs are not activation failures. [H5] [H6] `docs/operations.md:148–152` requires SQLite backup API/`VACUUM INTO`, not copying an active WAL database, and separate Postgres backup. Restore to a new database/cluster and extract CRW data: never rewind the shared CNPG cluster and other applications to roll back one beta. Treat GitOps backups as configured, not proven restorable.

## 5. Implementation and release plan

### Phase 0 — owner approves isolation

- **Change:** agree beta endpoint, separate BB data/credentials/projects, and no shared writable CRW storage. Keep package id `code-review-workspace`; no beta Settings toggle or second-id machinery.
- **Verify:** operator checklist records stable source/config unchanged; test BB uses different paths/endpoint; beta role cannot access the production database/schema. No reliance on a different schema name alone when the role can still write production.
- **Owner manually:** authorize/provision the isolated BB and private test repository. Start with new SQLite; supply beta-only credentials through normal secure setup. Do not copy a whole live BB installation with active threads/schedules.

### Phase 1 — release and schema gates in CRW

- **Change:** add the startup guards above and SQLite/Postgres upgrade/future-ledger tests; add a `1.12.1 → beta → restored 1.12.1` fixture rehearsal covering drafts, preferences, focus findings and lifecycle. Add CI checks on PRs and `v*-beta.*`/stable tags; CI validates versions and tests/builds, **does not publish implicitly**. Keep shipped migration statements immutable.
- **Verify:** future-schema startup refuses before mutation; failed migrations are atomic; restore retains the original data/settings. Run backend tests against throwaway Postgres 18 as well as SQLite, plus typecheck/lint/build and production-dependency bundle checks (`docs/development.md:23,27–40`). Resolve the known SDK/shim pin drift in a disposable checkout with a deliberately selected toolchain; verify declared engine floors or raise them honestly, not merely because the development pin changed.
- **Owner manually:** approve any engine-floor change; choose a sanitized representative snapshot and confirm its restore in disposable storage. Stop focus/agent work and close editing pages before release switching; test cancellation/restart as well as migration success (`src/focus-run.test.ts:59–70`).

### Phase 2 — focuses is the first beta

- **Change:** branch the release candidate from audited `927211a` plus Phase 1 fixes; set package/lockfile version **`1.13.0-beta.1`**, add a short CHANGELOG entry and beta runbook. Record exact commit, supported BB/SDK, schema delta, limitations and recovery policy. Subsequent fixes get new immutable `v1.13.0-beta.N` tags.
- **Verify before publishing:** clean candidate passes Phase 1 checks; tag, manifest and lockfile versions agree; remote tag is unused (`git ls-remote origin 'refs/tags/v1.13.0*'` returned no matches during research). Build/install smoke test on a disposable BB using Git's production-only dependency path. Re-run selection checks [E5]: neither the owner's `^1.0.0` nor catalog `^1.9.0` can select the beta. Review release notes for explicit “separate data; no same-data downgrade guarantee”.
- **Owner manually:** **after approval**, push the candidate and tag `v1.13.0-beta.1`; create a GitHub release marked prerelease, not Latest. Do not change the stable marketplace source. The tag's semver suffix protects stable range users; the GitHub checkbox is presentation, not BB's filter. [H3]
- **Owner manually, beta BB only:** verify CLI/server targeting, then install once:

  ```sh
  bb plugin install 'git:github.com/AndrewBird81/bb-plugin-code-review-workspace@semver:>=1.13.0-beta.1 <1.13.0'
  bb plugin source code-review-workspace --json
  ```

  Confirm the resolved tag/commit; keep auto-apply off. Use `bb plugin update code-review-workspace` for later betas in this train. Do not run these against the existing stable BB. Exact `@v1.13.0-beta.1` is an alternative for a one-off disposable install, but is pinned and cannot later be retargeted without removal. [H1] [H3]

### Phase 3 — owner acceptance, promotion and return

- **Change:** fix defects under new beta numbers; retain a short acceptance checklist: focuses off baseline, enable/customize focuses, restricted worker placement, run/stop/reload, keep/dismiss findings, draft labels and settings on desktop/phone. Use private test PRs; verify Postgres separately after SQLite, with a beta-only role/database.
- **Verify:** real isolated-host smoke test and restore rehearsal recorded; no production database, config or stable selector changed. Before GA, audit all beta migrations/serialized data and run the normal release gates again. A late failure means a new beta, never retagging.
- **Owner manually:** sign off; publish **`v1.13.0`** with version/changelog updated and normal release metadata. Existing stable ranges can then discover it; CRW's existing opt-in auto-updater may apply it when idle. Close stable views and take/rehearse both local-state and Postgres backups before accepting its migrations. Stop/discard the beta instance or start a fresh, explicitly selected next train; this beta-only range intentionally stops before GA. [H3] [E5]

### Deferred — only if same-server channel switching is required

- **bb-core work, outside this repo:** prepare/confirm a new managed source, atomically replace the same id while preserving settings/secrets/KV/schedules, retain local activation rollback and immutable provenance, support explicit version/downgrade, and expose it in SDK/CLI. Require external-database recovery acknowledgement; never claim a Postgres snapshot exists. Test cancellation, activation failure, retained credentials and downgrade refusal.
- **Then CRW:** Settings “Receive beta updates” invokes that host flow under the existing idle guard; do not store a disconnected boolean. Display selected source/resolved version/schema risk, and keep auto-apply independent. Returning to stable is a confirmed restore/compatibility operation, not silently changing a checkbox. [H1] [H2] [H5]

## Open questions — recommended answers

- **Must beta run inside the existing BB? Recommended: no; isolated BB for the first train.** If yes, revise scope: prefer bb-core replacement support over maintaining a duplicate identity.
- **Can beta share production reviews? Recommended: no writable sharing; sanitized clone or new data only.** Separate database and role preferred; a separate schema is acceptable only with verified privilege isolation. No later automatic merge-back.
- **Update behavior? Recommended: immutable `v1.13.0-beta.N`, one-train range, manual application.** No beta auto-apply initially; no public beta marketplace listing needed.
- **What constitutes recovery/signoff? Recommended: owner demonstrates snapshot restore and approves a SQLite + Postgres acceptance run before GA.** Confirm backup freshness and acceptable loss of beta-only changes; configured CNPG backups alone are not evidence of recovery.

## Command evidence and host references

- **[E5, V] Semver computation:** `node` with `semver.satisfies` (the host resolver uses this function [H3]) produced:

  ```text
  range                               accepted from the five candidates below
  ^1.0.0                              1.12.1, 1.13.0
  ^1.9.0                              1.12.1, 1.13.0
  ^1.13.0-beta.1                       1.13.0-beta.1, 1.13.0-beta.2, 1.13.0
  >=1.13.0-beta.1 <1.13.0               1.13.0-beta.1, 1.13.0-beta.2
  candidates: 1.12.1, 1.13.0-beta.1, 1.13.0-beta.2, 1.13.0, 1.14.0-beta.1
  ```

- Host links below are pinned to **`7b26cae79ec978fafd0a5db0e8517e94f12eb8f4`**, BB desktop 0.49.0 / SDK 0.6.132, not newer upstream `main`. Source was read via GitHub API; no host files were modified.

[host]: https://github.com/get-bb/bb/commit/7b26cae79ec978fafd0a5db0e8517e94f12eb8f4
[sdk-version]: https://github.com/get-bb/bb/blob/7b26cae79ec978fafd0a5db0e8517e94f12eb8f4/packages/plugin-sdk/package.json#L1-L3
[H1]: https://github.com/get-bb/bb/blob/7b26cae79ec978fafd0a5db0e8517e94f12eb8f4/apps/server/src/services/plugins/plugin-registration.ts#L286-L350
[H2]: https://github.com/get-bb/bb/blob/7b26cae79ec978fafd0a5db0e8517e94f12eb8f4/packages/sdk/src/areas/plugins.ts#L297-L326
[H3]: https://github.com/get-bb/bb/blob/7b26cae79ec978fafd0a5db0e8517e94f12eb8f4/apps/server/src/services/plugins/update-resolver.ts#L563-L573
[H4]: https://github.com/get-bb/bb/blob/7b26cae79ec978fafd0a5db0e8517e94f12eb8f4/packages/plugin-sdk/src/internal/host-policy.ts#L2831-L2884
[H5]: https://github.com/get-bb/bb/blob/7b26cae79ec978fafd0a5db0e8517e94f12eb8f4/apps/server/src/services/plugins/plugin-state-snapshot.ts#L136-L192
[H6]: https://github.com/get-bb/bb/blob/7b26cae79ec978fafd0a5db0e8517e94f12eb8f4/apps/server/src/services/plugins/plugin-activation.ts#L211-L305
[H7]: https://github.com/get-bb/bb/blob/7b26cae79ec978fafd0a5db0e8517e94f12eb8f4/apps/server/src/services/plugins/manifest.ts#L218-L225
[E5]: #command-evidence-and-host-references
[crw-release]: https://github.com/AndrewBird81/bb-plugin-code-review-workspace/releases/tag/v1.12.1
[historical-ci]: https://github.com/AndrewBird81/bb-plugin-code-review-workspace/blob/52486e1d66f406132d4da76f805d8b45830658bd/.github/workflows/ci.yml
