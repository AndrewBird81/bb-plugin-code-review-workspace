// Per-review UI state persisted to localStorage so the Guided Review panel
// survives tab switches / remounts: which review you were on, the chapter, the
// scroll position, the sidebar width, and focus mode. The floating agent dock
// persists its own geometry separately (see AgentDock).

export interface ReviewUiState {
  activeId?: string;
  view?: "diff" | "feedback" | "threads";
  scrollTop?: number;
  sidebarWidth?: number;
  focus?: boolean;
  toolsOpen?: boolean;
  activeTool?: "draft" | "notes" | "agent";
}

interface PanelState {
  lastTargetKey?: string;
  /** The chapter intro's overview is hidden, in every review. */
  introCollapsed?: boolean;
  /** The diff wraps long lines instead of scrolling them; unset follows the workspace's width. */
  wrapLines?: boolean;
  /** The sidebar lists the chapters, or every file as a folder tree, in every review. */
  navView?: NavView;
  perReview: Record<string, ReviewUiState>;
}

export type NavView = "chapters" | "files";

const KEY = "gr:panelstate";

function read(): PanelState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { perReview: {} };
    const parsed = JSON.parse(raw) as PanelState;
    return { ...parsed, perReview: parsed.perReview ?? {} };
  } catch {
    return { perReview: {} };
  }
}

function write(state: PanelState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage unavailable — persistence is best-effort.
  }
}

/** The most recently opened review, for a "Resume" affordance on the list. */
export function getLastReview(): { targetKey: string } | null {
  const key = read().lastTargetKey;
  return key ? { targetKey: key } : null;
}

export function setLastReview(targetKey: string) {
  const s = read();
  s.lastTargetKey = targetKey;
  write(s);
}

export function getReviewState(targetKey: string): ReviewUiState {
  return read().perReview[targetKey] ?? {};
}

export function patchReviewState(targetKey: string, patch: Partial<ReviewUiState>) {
  const s = read();
  s.perReview[targetKey] = { ...s.perReview[targetKey], ...patch };
  write(s);
}

export function getIntroCollapsed(): boolean {
  return read().introCollapsed ?? false;
}

export function setIntroCollapsed(collapsed: boolean) {
  const s = read();
  s.introCollapsed = collapsed;
  write(s);
}

export function getWrapLines(): boolean | undefined {
  return read().wrapLines;
}

export function setWrapLines(wrap: boolean) {
  const s = read();
  s.wrapLines = wrap;
  write(s);
}

export function getNavView(): NavView {
  return read().navView ?? "chapters";
}

export function setNavView(view: NavView) {
  const s = read();
  s.navView = view;
  write(s);
}
