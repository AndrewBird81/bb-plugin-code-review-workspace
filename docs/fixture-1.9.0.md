# 1.8.1 reading 1.9.0's data

`scripts/fixture-1.9.0.ts` checks a rollback to 1.8.1: it writes a database with every kind of data 1.9.0 adds, then reads it with 1.8.1's code, on SQLite and on Postgres. Run it before a release that changes what the store keeps.

1. Start a throwaway Postgres, and a v1.8.1 checkout:

   ```sh
   export "$(scripts/test-postgres.sh crw-pg-fixture 55499)"
   V=$(mktemp -d) && git archive v1.8.1 | tar -x -C "$V" && (cd "$V" && npm ci)
   OUT=$(mktemp -d)
   ```

2. Write 1.9.0's data, from this checkout: `data.db` and `keys.json` in `$OUT`, and the schema `crw_fixture_190` in Postgres.

   ```sh
   npx vite-node scripts/fixture-1.9.0.ts write "$OUT"
   ```

   The data: a folder's review that followed its branch's rename (`followed`, `formerBranches`) and became PR #31's, pushed under another name (`feature.remoteBranch`, `feature.headSha`), with its notice (`became`), its agent's note (`agentPrNote`), a sent comment, two open comments on lines only in its folder (side `LOCAL`) and Not pushed yet's diff (the `not-pushed` snapshot); PR #31's own review merged into it (`mergedInto`, `mergedAt`, archived; `mergedFrom` on the one that stays); a folder's review offering to merge with its PR's review (`prOffer`); and one holding an older PR (`prPending`), its Push and open PR under way (`push.thenOpenPr`).

3. Read it with 1.8.1, from its checkout:

   ```sh
   cp scripts/fixture-1.9.0.ts "$V/scripts/"
   (cd "$V" && npx vite-node scripts/fixture-1.9.0.ts read "$OUT")
   ```

   It prints `PASS` or `FAIL` for each check and exits 1 if any fails. The checks: every Store read of the data succeeds, on both backends; the review merged away reads as an archived PR review, and 1.8.1's `prReviewKey` gives it for PR #31; a draft posts a `LOCAL` comment with side `LOCAL`, never on a line of the PR's diff; 1.8.1's own writes keep 1.9.0's lifecycle keys, and so does the plugin running; the prune drops the `not-pushed` snapshot, and the `LOCAL` comments keep their code; each review opens, the one merged away with no comments; every draft loads but the converted review's, whose `LOCAL` comments 1.8.1 lists as stale, which its contract refuses; and Submit on it posts nothing. What it read is beside `data.db`: `reads-1.8.1-*.json`, `payloads-1.8.1-*.json`, `plugin-1.8.1.json` and `checks-1.8.1.json`.

   A stand-in `gh` and `git` go first on its PATH, so nothing reaches GitHub: `git` always fails, and `gh` answers only Submit's calls, as @casey, and keeps the review it would post.

4. `docker rm -f crw-pg-fixture`. Without `CRW_TEST_PG_URL`, both steps skip Postgres.

The other way, 1.9.0 reading 1.8.1's data, is `src/data-1.8.1.test.ts`, on `src/fixtures/1.8.1`: `scripts/fixture-1.8.0.ts write` run in a v1.8.1 checkout, without `CRW_TEST_PG_URL`, its `data.sql`, `reads.json`, `payloads.json` and `keys.json`.
