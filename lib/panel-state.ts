// Per-review UI state persisted to localStorage so the Guided Review panel
// survives tab switches / remounts: which review you were on, the chapter or
// Overview, the scroll position, the side panel, and the turn it last opened in;
// and the layout's widths and toggles, in every review. The floating agent dock
// persists its own geometry separately (see AgentDock).
import { NAV_WIDTH, PANEL_WIDTH } from "./workspace-layout";

export type PanelView = "comments" | "agent" | "finish";

export interface ReviewUiState {
  /** The chapter showing, or the Overview's id. */
  activeId?: string;
  /** Before 0.6.0, the view the review showed; read once to open its comments, then removed. */
  view?: "diff" | "feedback" | "threads";
  scrollTop?: number;
  /** The side panel's view, open again where it can dock. */
  panel?: PanelView | null;
  /** The turn the review last opened in, so it opens on its Overview only when it comes back to you. */
  turnSignal?: string;
  // Before 0.6.0; only migrateLayoutState reads them.
  sidebarWidth?: number;
  /** Not `focus`: before 0.5.0 every review opened saved Focus off, which kept phones on the full header. */
  headerCollapsed?: boolean;
  toolsOpen?: boolean;
  activeTool?: "draft" | "notes" | "agent";
}

interface PanelState {
  /** The layout this state is written for: 2 from 0.6.0, which migrateLayoutState brings older state to once. */
  layoutVersion?: number;
  /** The navigator is wanted beside the code, in every review; it docks where it fits. */
  navOpen?: boolean;
  navWidth?: number;
  panelWidth?: number;
  /** Comments in the code show as one-line markers; unset folds them on a phone or a short screen only. */
  commentsFolded?: boolean;
  /** The diff shows GitHub's threads under their lines. */
  githubThreadsInCode?: boolean;
  lastTargetKey?: string;
  /** The chapter intro's overview is hidden, in every review. */
  introCollapsed?: boolean;
  /** The diff wraps long lines instead of scrolling them; unset follows the workspace's width. */
  wrapLines?: boolean;
  /** Comments and the diff hide nit comments, in every review. */
  hideNits?: boolean;
  /** The sidebar lists the chapters, or every file as a folder tree, in every review. */
  navView?: NavView;
  /** The diff shows lines whose change is only whitespace as unchanged. */
  hideWhitespace?: boolean;
  perReview: Record<string, ReviewUiState>;
}

export type NavView = "chapters" | "files";

const KEY = "gr:panelstate";
const LAYOUT_VERSION = 2;

function read(): PanelState {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (isRecord(parsed) && parsed.layoutVersion === LAYOUT_VERSION) return { ...parsed, perReview: isRecord(parsed.perReview) ? parsed.perReview : {} } as PanelState;
    const migrated = migrateLayoutState(parsed);
    write(migrated);
    return migrated;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPanelView(value: unknown): value is PanelView {
  return value === "comments" || value === "agent" || value === "finish";
}

/** A saved width within its range, or its initial width when there's none to read. */
function savedWidth(width: unknown, range: { initial: number; min: number; max: number }): number {
  return typeof width === "number" && Number.isFinite(width) ? Math.min(range.max, Math.max(range.min, width)) : range.initial;
}

/**
 * State from before 0.6.0 in its layout: the last review's sidebar width becomes the navigator's, and each review's
 * open tool its side panel, where Draft review and Reviewer notes open Comments. The older keys stay as they were.
 */
export function migrateLayoutState(stored: unknown): PanelState {
  const state = isRecord(stored) ? stored : {};
  const perReview: Record<string, ReviewUiState> = {};
  for (const [targetKey, review] of Object.entries(isRecord(state.perReview) ? state.perReview : {})) {
    if (!isRecord(review)) continue;
    // Without a saved tool, the open panel showed Draft review.
    const tool = review.activeTool ?? (review.toolsOpen === true ? "draft" : undefined);
    const panel = review.toolsOpen === false ? null : tool === "agent" ? "agent" : tool === "draft" || tool === "notes" ? "comments" : undefined;
    perReview[targetKey] = { ...review, ...(review.panel === undefined && panel !== undefined ? { panel } : {}) };
  }
  const last = typeof state.lastTargetKey === "string" ? perReview[state.lastTargetKey] : undefined;
  const navWidth = typeof last?.sidebarWidth === "number" && state.navWidth === undefined ? { navWidth: savedWidth(last.sidebarWidth, NAV_WIDTH) } : {};
  return { ...state, ...navWidth, perReview, layoutVersion: LAYOUT_VERSION };
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
  const state = read().perReview[targetKey] ?? {};
  return state.panel == null || isPanelView(state.panel) ? state : { ...state, panel: null };
}

export function patchReviewState(targetKey: string, patch: Partial<ReviewUiState>) {
  const s = read();
  s.perReview[targetKey] = { ...s.perReview[targetKey], ...patch };
  write(s);
}

export function getIntroCollapsed(): boolean | undefined {
  return read().introCollapsed;
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

export function getHideNits(): boolean {
  return read().hideNits ?? false;
}

export function setHideNits(hide: boolean) {
  const s = read();
  s.hideNits = hide;
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

export function getHideWhitespace(): boolean {
  return read().hideWhitespace ?? false;
}

export function setHideWhitespace(hide: boolean) {
  const s = read();
  s.hideWhitespace = hide;
  write(s);
}

export function getNavOpen(): boolean {
  const open = read().navOpen;
  return typeof open === "boolean" ? open : true;
}

export function setNavOpen(open: boolean) {
  const s = read();
  s.navOpen = open;
  write(s);
}

export function getNavWidth(): number {
  return savedWidth(read().navWidth, NAV_WIDTH);
}

export function setNavWidth(width: number) {
  const s = read();
  s.navWidth = savedWidth(width, NAV_WIDTH);
  write(s);
}

export function getPanelWidth(): number {
  return savedWidth(read().panelWidth, PANEL_WIDTH);
}

export function setPanelWidth(width: number) {
  const s = read();
  s.panelWidth = savedWidth(width, PANEL_WIDTH);
  write(s);
}

export function getCommentsFolded(): boolean | undefined {
  const folded = read().commentsFolded;
  return typeof folded === "boolean" ? folded : undefined;
}

export function setCommentsFolded(folded: boolean) {
  const s = read();
  s.commentsFolded = folded;
  write(s);
}

export function getGithubThreadsInCode(): boolean {
  const show = read().githubThreadsInCode;
  return typeof show === "boolean" ? show : true;
}

export function setGithubThreadsInCode(show: boolean) {
  const s = read();
  s.githubThreadsInCode = show;
  write(s);
}
