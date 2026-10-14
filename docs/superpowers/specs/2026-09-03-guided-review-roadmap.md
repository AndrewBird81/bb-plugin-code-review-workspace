# Guided Review → marketplace-grade: roadmap

Date: 2026-09-03
Status: Phase 1 done or dropped; Phase 2 partly built (two items open); Phase 3 partly done. Per-item state in brackets.

This plugin is being published to the BB marketplace. Everything below is what
we're building toward, grouped so each phase ships something coherent, tested,
and reviewable rather than a scattershot mega-change.

## Phase 1 — Panel UX & screen utilization  [done]

- **Landing/list redesign** — modern, card-based grid (not full-width rows),
  gradients + tasteful icons, kind/status badges, author + relative time, a
  prominent "Resume last review", and a real empty state. [Superseded by the Inbox list; Resume dropped in 0.6.]
- **Loading states → skeleton shimmer** — replace the "Building the guide…" text
  and the list's blank load with animated skeletons; icon-rich, reduced-motion
  aware, split into their own component. [Done: ReviewSkeleton.]
- **Persistence across tab switches** — remember the last review, current chapter,
  scroll position, sidebar width, focus mode, and the agent dock/messages.
  [Done: `lib/panel-state.ts`; the last-review and focus parts dropped.]
- **Resizable sections** — drag-divider between sidebar and diff (persisted,
  collapsible to a rail); resizable/collapsible draft tray. Use all the width. [Done.]
- **Focus mode + true full screen** — a Focus toggle that compresses chrome
  (header→slim, banners tucked, tray minimized, overview clamped) AND a separate
  button that calls the Fullscreen API on the panel root. [Full screen done; Focus mode removed.]
- **GitHub-style line selection** — pierre `enableLineSelection` + gutter "+"
  (`enableGutterUtility`/`onGutterUtilityClick`), controlled `selectedLines`
  highlight; a selection action bar → **Add comment** (inline composer via
  `renderAnnotation`, saved to the existing draft) or **Ask agent** (inject
  `{file, startLine, endLine, code}` into the dock). [Done.]

## Phase 2 — Reviewer-agent intelligence

> Open question resolved by the "reviewer agent" clarifier below.

- **Persona / custom prompt** — a user-defined persona + extra instructions
  applied when the reviewer agent runs; stored in plugin storage, editable. [Done: Settings' assistant instructions.]
- **Self-learning loop** — capture each review comment the user writes together
  with the code it targets; periodically distill those into concrete
  improvements to the reviewer agent's prompt/rules, surfaced for the user to
  approve before they take effect. [Done: suggested assistant instructions.]
- **Reviewer-agent dashboard** — a panel section to view/edit the agent's
  persona, prompt, and rules; a changelog of what changed, when, and why; and
  per-feature toggles. [Open: not built.]
- **Scheduled self-improvement** — an opt-in bb automation (daily/weekly) that
  runs the distillation; plus a lightweight check when the agent runs in a new
  thread that pulls the latest improved prompt. Fully toggleable. [Open: not built.]

## Phase 3 — Marketplace readiness & QA

- **Code/correctness review agent** pass over the whole extension; fix findings.
- **UX review agent** pass over every screen; fix findings.
- **Clean commit/PR flow** — reshape the branch into coherent commits, open a PR
  with a guided-review of itself.
- **Versioning & updates** — bump the version; a CHANGELOG; an in-app "what's
  new"/updates surface; feature toggles in settings. [Done: CHANGELOG, plugin updates in Settings.]
- **GitHub release** — tag `vX.Y.Z` with release notes; confirm the
  `bb-marketplace` catalog range picks it up. [Open: the fork's last tag is v0.2.1.]

## Decided — "the reviewer agent" == the guide generator

The persona + rules shape how the **guide generator** authors chapters, risk
flags, and overviews. The self-learning loop improves that *generation* prompt
from the user's review comments. No separate critique/findings agent; the
floating Q&A dock keeps its own lightweight prompt. The Phase-2 dashboard edits
the generator's persona/rules and shows their change history.
