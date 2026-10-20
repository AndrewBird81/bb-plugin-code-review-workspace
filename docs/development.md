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
- The plugin builds and tests against the SDK pinned in devDependencies (0.6.49), and uses only what the SDK floor, 0.6.14, has.
- Use a Node.js version compatible with the installed `better-sqlite3` package (this release was verified on Node.js 24).
- BB builds the plugin from source when it installs or updates it, so the build output in `dist/` isn't committed.
- Keep published tags immutable.

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
