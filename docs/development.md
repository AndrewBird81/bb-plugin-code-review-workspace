# Developing Code Review Workspace

How to build and test the plugin. [DESIGN.md](../DESIGN.md) describes the interface system, [PRODUCT.md](../PRODUCT.md) what the plugin is for, and [CHANGELOG.md](../CHANGELOG.md) each release's changes.

## Development

```sh
npm ci
bb plugin types
npm run check
bb plugin install .
bb plugin dev
```

- Development checks use the SDK test harness, temporary Git repositories, and mocked GitHub writes. A backend test that runs the real `gh` fails: a stand-in `gh` goes first on `PATH`.
- Frontend tests are collected from `components/`, `lib/`, and `hooks/`, in `.ts` or `.tsx`.
- `npm run typecheck` covers the server's tests, the browser tests, and the vitest config too.
- `server.ts` opens the store and starts what runs on it. Each area of the server is a module in `src/` whose `register(deps)` registers its agent tools and returns its RPC handlers, its listeners to BB's events, and the `bb review` subcommands it runs; `src/server-modules.ts` has what they get and give, the subcommand table, and the tools each thread gets. `src/registrations.test.ts` snapshots everything the plugin registers: a change that adds or changes a tool, RPC method or subcommand updates it with `npx vitest run src/registrations.test.ts -u`.
- The plugin builds and tests against the SDK pinned in devDependencies (0.6.94), and uses only what the SDK floor, 0.6.14, has.
- Use a Node.js version compatible with the installed `better-sqlite3` package (this release was verified on Node.js 24).
- BB builds the plugin from source when it installs or updates it, so the build output in `dist/` isn't committed.
- BB installs a Git plugin's dependencies without dev or optional packages (`--omit=dev --omit=optional`), so whatever the server's bundle takes code from must be a dependency of its own, as `pg-cloudflare` is for `pg`. `src/server-bundle.test.ts` checks every package in the bundle.
- Keep published tags immutable.
- The README's icon is two copies of `assets/icon.svg` with GitHub's text colour in place of `currentColor`, which an `<img>` draws black. When the icon changes, regenerate them from the repo root: `sed 's/currentColor/#1f2328/' assets/icon.svg > docs/images/icon-light.svg && sed 's/currentColor/#f0f6fc/' assets/icon.svg > docs/images/icon-dark.svg`.

## Backend tests on Postgres

The backend tests run the Store on SQLite. To run them on Postgres, `scripts/test-postgres.sh [name] [port]` starts a throwaway `postgres:18` container in Docker, initialised with `--locale=C` and serving TLS 1.3 as the homelab cluster does, and prints `CRW_TEST_PG_URL=…` for it:

```sh
export "$(scripts/test-postgres.sh crw-test-pg 55432)"
npm test -- --project backend
docker rm -f crw-test-pg
```

- With `CRW_TEST_PG_URL` set, `createStore` returns the Store over a Postgres schema of each fake host's own, migrated by its first statement and dropped once its test ends (`src/test-backend.test-support.ts`). The plugin a test starts and the test's own `testStore(bb)` share that schema, and `testSql(bb)` reaches its tables.
- `src/store-backends.test.ts` runs a seeded random sequence of Store calls on SQLite and on Postgres, and compares each call's answer and every read after it. `src/storage-postgres.test.ts` starts the plugin on Postgres storage, as its settings choose it, and `src/storage-cli.test.ts` moves seeded reviews to Postgres and back with `bb review storage`. They, and the tests in `src/db/` that connect to Postgres, are skipped without the URL.
- `scripts/storage-round-trip.ts` does the same with a copy of a real `data.db`, such as a production snapshot, as an operator would, and writes the table checksums and reads dumps of what came back, to compare with `scripts/store-dump.ts`'s of the snapshot: `npx vite-node scripts/storage-round-trip.ts <data.db> <out dir>`, with `CRW_TEST_PG_URL` set.
- A few tests are SQLite's alone: the former install's import, the dump script, the SQLite executor's own, and a query plan's index.

## Browser regression test

Use Node 24, matching the installed SQLite native module. Build and reload this plugin in an isolated test BB, then run:

```sh
npm ci
npx playwright install chromium
bb plugin build
BB_SERVER_URL=http://127.0.0.1:4331 bb plugin reload code-review-workspace
BB_E2E_URL=http://127.0.0.1:4331 npm test -- --project e2e
```

`BB_E2E_URL` must point at a BB on this machine (`127.0.0.1`, `localhost`, or `[::1]`): the test writes reviews and settings to the BB it reaches.

- The browser uses the running BB shell and built plugin UI. Code Review Workspace RPC requests are intercepted into the official SDK test host with real temporary SQLite. GitHub and agent calls are stubbed at their external boundaries, so no real PR review or agent thread is created.
- The flow covers settings persistence, the Overview and Start reading, Comments from BB's title bar and its state across a reload, adding a comment by line and editing it in the code, keyboard tooltips, Finish review's summary, verdict, and private notes, Finish in a 390px phone's Comments sheet above the dock, full screen's verdict and Submit, reload, starting a review agent conversation with file context, Pop out and Dock keeping a half-typed message, All reviews' sections, and merge archival.
- Without `BB_E2E_URL`, this test is skipped.

A second browser test checks Needs You notifications: a finished guide's popup, opening the review from it, the retained inbox row, and Dismiss. It needs a separate isolated test BB on port 4333 with Needs You installed, and saves a screenshot to `docs/verification/` (gitignored):

```sh
BB_ACTIVITY_E2E_URL=http://127.0.0.1:4333 npm test -- --project e2e
```

Without `BB_ACTIVITY_E2E_URL`, it is skipped.
