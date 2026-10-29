# 1.7.0 reading 1.8.0's data

`scripts/fixture-1.8.0.ts` checks a rollback to 1.7.0: it writes a database with every kind of data 1.8.0 adds, then reads it with 1.7.0's code, on SQLite and on Postgres. Run it before a release that changes what the store keeps.

1. Start a throwaway Postgres, and a v1.7.0 checkout:

   ```sh
   export "$(scripts/test-postgres.sh crw-pg-fixture 55499)"
   V=$(mktemp -d) && git archive v1.7.0 | tar -x -C "$V" && (cd "$V" && npm ci)
   OUT=$(mktemp -d)
   ```

2. Write 1.8.0's data, from this checkout: `data.db` and `keys.json` in `$OUT`, and the schema `crw_fixture_180` in Postgres.

   ```sh
   npx vite-node scripts/fixture-1.8.0.ts write "$OUT"
   ```

3. Read it with 1.7.0, from its checkout:

   ```sh
   cp scripts/fixture-1.8.0.ts "$V/scripts/"
   (cd "$V" && npx vite-node scripts/fixture-1.8.0.ts read "$OUT")
   (cd "$V" && npx vite-node scripts/store-dump.ts "$OUT/data.db" "$OUT/reads.json" "$OUT/checksums.json")
   ```

   It prints `PASS` or `FAIL` for each check and exits 1 if any fails. The checks: every Store read of the data succeeds, on both backends; each review opens, a folder's review on its last snapshot, with no git; `sent` reads as stored; 1.7.0's own writes keep 1.8.0's lifecycle keys and its three switches; an edit drops the comment's id and state; the prune drops the `send:<n>` snapshots; and Submit posts every comment in the draft, sent, resolved and dismissed ones too. What it read is beside `data.db`: `reads-1.7.0-*.json`, `payloads-1.7.0-*.json`, `plugin-1.7.0.json` and `checks-1.7.0.json`.

   A stand-in `gh` and `git` go first on its PATH, so nothing reaches GitHub: `git` always fails, and `gh` answers only Submit's calls, as @casey, and keeps the review it would post.

4. `docker rm -f crw-pg-fixture`. Without `CRW_TEST_PG_URL`, both steps skip Postgres.
