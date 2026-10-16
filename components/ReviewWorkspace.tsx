import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useRpc, useRealtime, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Toaster, toast } from "sonner";
import type { SelectedLineRange } from "@pierre/diffs";
import type { rpcContract } from "../src/rpc-contract";
import type { AgentMessageContext } from "../src/store";
import { sameLocation, type CommentLocation } from "../src/draft";
import type { FileInterdiff } from "../src/interdiff";
import { baselineOf, computeTurn, type TurnReason } from "../lib/turn";
import { notRunReason } from "../lib/trust";
import { cn } from "../lib/utils";
import { experimental_useCodeTheme } from "@get-bb/plugin-sdk/app";
import { getCommentsFolded, getGithubThreadsInCode, getHideWhitespace, getNavOpen, getNavView, getNavWidth, getPanelWidth, getReviewState, getWrapLines, patchReviewState, setCommentsFolded, setGithubThreadsInCode, setHideWhitespace, setNavOpen as saveNavOpen, setNavView, setNavWidth as saveNavWidth, setPanelWidth as savePanelWidth, setWrapLines, type NavView, type PanelView } from "../lib/panel-state";
import { OVERVIEW, WorkspaceProvider, type WorkspaceApi } from "../lib/workspace-context";
import { NAV_WIDTH, PANEL_WIDTH, READER_MIN, panelDockWidth, useWorkspaceLayout, type LayoutState } from "../lib/workspace-layout";
import { useKeyboardInset } from "../lib/use-keyboard-inset";
import { useFold } from "../lib/use-fold";
import { useSafeArea } from "../lib/use-safe-area";
import { flipPlace, goToFlipPlace, goToPlace, linePlace, useScrollAnchor, type FlipPlace } from "../lib/use-scroll-anchor";
import { carried, keep, present, type KeptFocus } from "../lib/remount";
import { CompactViewportOverrideProvider } from "./ui/hooks/use-compact-viewport";
import { useMediaQuery } from "./ui/hooks/use-media-query";
import { Button } from "./ui/button";
import type { FileOwners } from "../src/codeowners";
import { ChapterIntro } from "./ChapterIntro";
import { ChapterViewSwitch } from "./ChapterNav";
import { DiffViewer, diffLines, type FileViewFlags } from "./DiffViewer";
import { DraftProvider, type CommentPrefill } from "./DraftProvider";
import { TrackedReview } from "./TrackedReview";
import { NotRunButton } from "./NotRunBanner";
import { AgentDock, type DockInjection } from "./AgentDock";
import { ReviewSkeleton, ReviewError } from "./ReviewSkeleton";
import { AccountBar } from "./AccountBar";
import { defaultPreferences, type ReviewPreferences } from "../lib/review-preferences";
import { TEXT_FIELD, inDiffOrder, readingOrder, shortcutKey } from "../lib/review-shortcuts";
import { stepComment, useCommentStep } from "../lib/comment-stops";
import { InlineDraftContext } from "./InlineDraft";
import { DiffThreadsContext, useDiffThreads } from "./LineThreads";
import { CheckFailuresContext, useCheckFailures } from "./CheckFailures";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { Navigator } from "./Navigator";
import { ReviewOverview } from "./ReviewOverview";
import { DiffOptions } from "./reading/DiffOptions";
import { ReaderBar } from "./reading/ReaderBar";
import { ChapterFooter } from "./reading/ChapterFooter";
import { CommentsView, focusComments, type CommentsTab } from "./comments/CommentsView";
import { FinishView } from "./comments/FinishView";
import { StepBar } from "./comments/StepBar";
import { NavigatorHost } from "./shell/NavigatorHost";
import { PhoneDock } from "./shell/PhoneDock";
import { returnFocus } from "./shell/side-parts";
import { ReviewNotices, useNewCommits, type Notice } from "./shell/ReviewNotices";
import { SelectionBar } from "./shell/SelectionBar";
import { SidePanel, sidePanelId } from "./shell/SidePanel";
import { TopBand, navigatorId } from "./shell/TopBand";
import { ReviewMenu } from "./TitleBarControls";
import { TOUCH_CONTROL } from "./touch";
import { splitPatchByFile } from "../src/patch";
import { chapterAt, droppedNear, filePart, fitHunks, hunksIn } from "../src/hunks";
import { approveGuard } from "../lib/approve-guard";
import { useKnob, useSettings } from "../lib/settings";
import { changedLines, chapterReadingLines, readingLines } from "../lib/review-size";

/** The guide's chapters, then any changed files they don't list, such as an older guide's unplaced files. */
function withOtherFiles(sections: any[], patch: string): any[] {
  const placed = new Set(sections.flatMap((section) => section.diffs.map((diff: any) => diff.file)));
  const other = splitPatchByFile(patch).map((f) => f.path).filter((path) => !placed.has(path));
  // A guide can have its own Other files chapter, for the files it left unplaced.
  const id = sections.some((section) => section.id === OTHER_FILES) ? `${OTHER_FILES}-unlisted` : OTHER_FILES;
  return other.length ? [...sections, { id, title: "Other files", overview: "Changed files the guide doesn’t place in a chapter.", diffs: other.map((file) => ({ file })) }] : sections;
}
const OTHER_FILES = "other-files";

function viewMap(views: { file: string; viewed: boolean; stale: boolean; viewedAt?: number }[]): Map<string, FileViewFlags> {
  return new Map(views.map((v) => [v.file, { viewed: v.viewed, stale: v.stale, viewedAt: v.viewedAt }]));
}

/** Where you're typing in the review `targetKey`, if you are: in its chapters (Find in review), its side panel, or elsewhere. */
function typingIn(targetKey: string): LayoutState["typingIn"] {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement && (active.isContentEditable || active.closest(TEXT_FIELD)))) return undefined;
  return document.getElementById(navigatorId(targetKey))?.contains(active) ? "nav" : document.getElementById(sidePanelId(targetKey))?.contains(active) ? "panel" : "other";
}

/** Hands the workspace the lines with draft comments or discussions, which the draft provides, without the nits it hides. */
function DraftLines({ into }: { into: MutableRefObject<CommentLocation[]> }) {
  const draft = useContext(InlineDraftContext);
  useEffect(() => {
    // A hidden nit's line shows nothing, not even its discussion.
    const nits = draft?.hideNits ? draft.comments.filter((c) => c.severity === "nit") : [];
    into.current = [...(draft?.comments ?? []), ...(draft?.discussions ?? [])].filter((at) => !nits.some((nit) => sameLocation(nit, at)));
  }, [draft, into]);
  return null;
}

/** How long opening a review waits for its first settings before it opens with the defaults. */
const SETTINGS_WAIT_MS = 1000;
/** Turns where what matters first is whether the author addressed your feedback. */
const FEEDBACK_FIRST = new Set<TurnReason>(["re-requested", "handled", "looks-ready", "question", "mentioned"]);
/** No file's owners: what the code shows with Settings' Code owners off. */
const NO_OWNERS: ReadonlyMap<string, FileOwners> = new Map();

export const ReviewWorkspace = memo(function ReviewWorkspace({ targetKey }: { targetKey: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const codeTheme = experimental_useCodeTheme();
  const [preferences, setPreferences] = useState<{ preferences: ReviewPreferences; revision: number } | null>(null);
  const diffLayout = preferences?.preferences.diffLayout ?? defaultPreferences.diffLayout;
  const [loading, setLoading] = useState(true);
  const [generatingReplacement, setGeneratingReplacement] = useState(false);
  const hasDisplayedGuide = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const request = useRef(0);
  const viewsRequest = useRef(0);
  // The guide as last shown; a reload with the same guide keeps its object, so the diff doesn't redraw.
  const shownGuide = useRef("");
  // The diff as last shown, which a reload with the same revision doesn't send again.
  const shownPatch = useRef<{ targetKey: string; revision: string; patch: string } | null>(null);
  const persisted = useMemo(() => getReviewState(targetKey), [targetKey]);
  // The first settings load, which load waits for: a ref, as load is kept for the review.
  const firstSettings = useSettings().settled;
  const settledRef = useRef(firstSettings);
  settledRef.current = firstSettings;

  const [review, setReview] = useState<any>(null);
  const [guide, setGuide] = useState<any>(null);
  const [patch, setPatch] = useState("");
  const [checks, setChecks] = useState<{ bucket: string; checks: any[] } | null>(null);
  // A chapter's id or OVERVIEW, which the review's first load picks (the opening rules); until then it's empty.
  const [activeId, setActiveId] = useState("");
  const opened = useRef(false);
  // The saved scroll position, and the page it was saved on, when the review opens where it was saved.
  const restoreScroll = useRef<{ id: string; top: number } | null>(null);
  // A remounted workspace is putting its line back, or waiting to: that line, not what's at the code's top meanwhile, is
  // the place.
  const restoringPlace = useRef(false);
  // What the workspace this one took the place of had open, typed, showed and focused, as BB remounts the page when its
  // layout switches (lib/remount.ts); null for a review opened as usual. Read once, as it mounts.
  const [carry] = useState(() => carried(targetKey));
  const carriedPlace = useRef(carry?.place ?? null);
  const carriedFocus = useRef(carry?.focus ?? null);
  // Where you were typing, until the focus is back there: what's open goes where it would in place.
  const carriedTyping = useRef(carry?.focus?.typing);
  const carriedLines = useRef(carry?.lines ?? null);
  const [revision, setRevision] = useState("");
  const [repoAccess, setRepoAccess] = useState<{ accessible: boolean; repo: string | null; account: string | null } | null>(null);
  const [views, setViews] = useState<Map<string, FileViewFlags>>(new Map());
  const [generated, setGenerated] = useState<Set<string>>(new Set());
  const [injection, setInjection] = useState<DockInjection | undefined>();
  const [currentFile, setCurrentFile] = useState<string | undefined>();
  const [lineSel, setLineSel] = useState<{ file: string; range: SelectedLineRange } | null>(null);
  const [draftPrefill, setDraftPrefill] = useState<CommentPrefill | undefined>();
  const [showDraft, setShowDraft] = useState<{ at: number; replaced?: boolean } | undefined>();
  // What changed since what the diff compares with, or why that couldn't be read, with the comparison it's for.
  const [sinceRead, setSinceRead] = useState<{ key: string; files: Map<string, FileInterdiff> } | null>(null);
  const [sinceFailed, setSinceFailed] = useState<{ key: string; error: string } | null>(null);
  // Whether the band has room for the compare select: where it hasn't, the diff says what it shows, and switches it.
  const [compareShown, setCompareShown] = useState(true);
  // What you chose to compare with, as you left the review: a commit picked, or your last review, narrowed or not.
  const [chosen, setChosen] = useState(() => persisted.compare ?? null);
  const [owners, setOwners] = useState<Map<string, FileOwners>>(new Map());
  // Chapters or All files, in every review.
  const [navView, setNavViewState] = useState(getNavView);
  const changeNavView = useCallback((next: NavView) => { setNavViewState(next); setNavView(next); }, []);
  const [snoozing, setSnoozing] = useState(false);
  const [reveal, setReveal] = useState<{ at: CommentLocation; nonce: number }>();
  const [foldAll, setFoldAll] = useState<{ folded: boolean; nonce: number }>();
  const [isFullscreen, setIsFullscreen] = useState(false);
  // An iPhone can't make a page full screen, so there the workspace covers the window from the top layer instead.
  const [covering, setCovering] = useState(false);

  const fileEls = useRef<Map<string, HTMLElement>>(new Map());
  const pendingScroll = useRef<string | null>(null);
  const scrollBox = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);

  // Where the navigator and the side panel go, from the workspace's own size (lib/workspace-layout.ts): what you want,
  // which holds in every review, and the overlays you open where they can't dock, which don't.
  const [navOpen, setNavOpenState] = useState(getNavOpen);
  const [navOverlay, setNavOverlay] = useState(carry?.navOverlay ?? false);
  const [navWidth, setNavWidth] = useState(getNavWidth);
  const [panelWidth, setPanelWidth] = useState(getPanelWidth);
  // The panel's view, which opens again only where it can dock.
  const [panelView, setPanelView] = useState<PanelView | null>(persisted.panel ?? null);
  const [panelOverlay, setPanelOverlay] = useState(carry?.panelOverlay ?? false);
  const [commentsTab, setCommentsTab] = useState<CommentsTab>("drafts");
  // Comments was to open as the review opened, but couldn't beside the code: the "need you" pill offers it instead.
  const [pill, setPill] = useState(false);
  // Comments to open as the review opens, on this tab: decided once the workspace has its own size, as BB's pane can be
  // narrower than the window, all there is to measure before the workspace renders.
  const [opening, setOpening] = useState<CommentsTab | null>(null);
  // Where you're typing: a phone's fold or rotation keeps that side open, over the code if it must, and hides the side
  // you're not typing in rather than cover your box. Read as it renders, as the resize renders it: it's never stale, as
  // it would be after the box you typed in went away with the focus, which tells no one.
  const layout = useWorkspaceLayout(rootEl, { navWidth, panelWidth, navOpen, navOverlay, typingIn: typingIn(targetKey) ?? carriedTyping.current, panelOpen: panelView !== null, panelOverlay }, targetKey);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // The panel's view as it shows, docked or over the code.
  const shownPanel = layout.panel === "closed" ? null : panelView;
  const shownPanelRef = useRef(shownPanel);
  shownPanelRef.current = shownPanel;
  const commentsTabRef = useRef(commentsTab);
  commentsTabRef.current = commentsTab;
  // Overlays don't come back by themselves: once a side docks or hides, it was never opened over the code. Unless a
  // phone's fold, unfold or rotation docked it: the chapters you had open over the code go back there with the next.
  useEffect(() => { if (layout.nav === "closed" || layout.nav === "suppressed" || (layout.nav === "docked" && !layout.phoneResized)) setNavOverlay(false); }, [layout.nav]);
  // Over the code after such a resize, they stay there: before paint, while the resize still has them there.
  useLayoutEffect(() => { if (layout.nav === "overlay") setNavOverlay(true); }, [layout.nav]);
  useEffect(() => { if (layout.panel === "docked") setPanelOverlay(false); }, [layout.panel]);
  useEffect(() => patchReviewState(targetKey, { panel: panelView }), [targetKey, panelView]);
  // For a workspace that may take this one's place (lib/remount.ts): that this one is here, what's over the code, the
  // lines selected, and what has the focus, with the caret.
  useLayoutEffect(() => present(targetKey), [targetKey]);
  useEffect(() => keep(targetKey, { navOverlay, panelOverlay }), [targetKey, navOverlay, panelOverlay]);
  useEffect(() => keep(targetKey, { lines: lineSel }), [targetKey, lineSel]);
  const keepFind = useCallback((find: string) => keep(targetKey, { find }), [targetKey]);
  useEffect(() => {
    if (!rootEl) return;
    const note = () => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !rootEl.contains(active)) return;
      const caret = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? [active.selectionStart ?? 0, active.selectionEnd ?? 0] as [number, number] : undefined;
      const typing = typingIn(targetKey);
      const focus: KeptFocus | null = active.matches("[data-find-box]") ? { in: "find", caret, typing }
        : active.matches("textarea") && active.closest("[data-keyboard-box]") ? { in: "composer", caret, typing }
        : document.getElementById(sidePanelId(targetKey))?.contains(active) ? { in: "panel" } : null;
      // Typing in the code, the box is where you are (as on a scroll); elsewhere the code's top stays the place it was, as
      // it does while a remounted workspace puts its place back, the focus with it.
      keep(targetKey, scrollBox.current?.contains(active) && !restoringPlace.current ? { focus, place: linePlace(scrollBox.current) } : { focus });
    };
    // Gone from the workspace, not with it: as BB remounts the page, the old one's focus goes with its nodes.
    const left = () => setTimeout(() => { if (rootEl.isConnected && !rootEl.contains(document.activeElement)) keep(targetKey, { focus: null }); });
    const events = ["focusin", "keyup", "input", "pointerup", "select"] as const;
    events.forEach((type) => rootEl.addEventListener(type, note));
    rootEl.addEventListener("focusout", left);
    return () => {
      events.forEach((type) => rootEl.removeEventListener(type, note));
      rootEl.removeEventListener("focusout", left);
    };
  }, [rootEl, targetKey]);
  // The focus as a remounted workspace had it, once what had it is back: Find in review's box, the comment box (which
  // the draft brings back), or the side panel.
  useEffect(() => {
    const focus = carriedFocus.current;
    if (!focus || !activeId) return;
    carriedFocus.current = null;
    let frame = 0;
    const until = Date.now() + 3000;
    const attempt = () => {
      const root = rootRef.current;
      const el = focus.in === "find" ? root?.querySelector<HTMLInputElement>("[data-find-box]")
        : focus.in === "composer" ? root?.querySelector<HTMLTextAreaElement>("[data-keyboard-box] textarea")
        : document.getElementById(sidePanelId(targetKey))?.querySelector<HTMLElement>("button[aria-label^='Close']");
      if (el?.checkVisibility?.() ?? el?.isConnected) {
        el!.focus({ preventScroll: true });
        if (focus.caret && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.setSelectionRange(...focus.caret);
        carriedTyping.current = undefined;
      } else if (Date.now() < until) frame = requestAnimationFrame(attempt);
      else carriedTyping.current = undefined;
    };
    attempt();
    // A chapter changed before it's back: it won't be, and you're not typing there.
    return () => { cancelAnimationFrame(frame); carriedTyping.current = undefined; };
  }, [activeId, targetKey]);
  // The navigator hidden with the focus in it, as when the panel docks over its room: the chapters toggle takes it.
  // Before paint, while the hidden navigator still has the focus.
  const shownNav = useRef(layout.nav);
  useLayoutEffect(() => {
    const was = shownNav.current;
    shownNav.current = layout.nav;
    if (was !== "docked" || layout.nav === "docked" || layout.nav === "overlay") return;
    const host = document.getElementById(navigatorId(targetKey));
    // The band's toggle, or a phone's chapters tab.
    const toggle = rootRef.current?.querySelector<HTMLElement>(`main [aria-controls="${navigatorId(targetKey)}"], [aria-label="Review commands"] > [aria-controls="${navigatorId(targetKey)}"]`);
    if (host?.contains(document.activeElement)) returnFocus(toggle, host);
  }, [layout.nav, targetKey]);

  const changeNavOpen = useCallback((open: boolean) => { setNavOpenState(open); saveNavOpen(open); }, []);
  /** Show the navigator: docked where it fits, else over the code, in place of the panel if that's over it too. */
  const showNav = useCallback(() => {
    const { nav, navCanDock, panel } = layoutRef.current;
    if (nav === "docked" || nav === "overlay") return;
    if (navCanDock) return changeNavOpen(true);
    setNavOverlay(true);
    if (panel === "overlay") { setPanelView(null); setPanelOverlay(false); }
  }, [changeNavOpen]);
  const toggleNav = useCallback(() => {
    const { nav } = layoutRef.current;
    // Docked, it may have been over the code before the window resized: hidden, it doesn't go back there.
    if (nav === "docked") { changeNavOpen(false); setNavOverlay(false); }
    else if (nav === "overlay") setNavOverlay(false);
    else showNav();
  }, [changeNavOpen, showNav]);
  const findInReview = useCallback(() => {
    showNav();
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLInputElement>("[data-find-box]")?.focus());
  }, [showNav]);
  // One overlay at a time: BB's title bar, outside the dimmed workspace, can open the panel over the chapters.
  const openPanel = useCallback((view: PanelView) => {
    setPanelView(view);
    setPanelOverlay(!layoutRef.current.panelCanDock);
    setNavOverlay(false);
  }, []);
  const closePanel = useCallback(() => { setPanelView(null); setPanelOverlay(false); }, []);
  const togglePanel = useCallback((view: PanelView) => shownPanelRef.current === view ? closePanel() : openPanel(view), [openPanel, closePanel]);
  const openComments = useCallback((tab: CommentsTab) => { setCommentsTab(tab); openPanel("comments"); }, [openPanel]);
  // The draft shows its box or chat: Comments, unless the draft is showing already, in Finish or Comments' Drafts.
  const openDraftView = useCallback((view: PanelView) => {
    const shown = shownPanelRef.current;
    if (view !== "comments") openPanel(view);
    else if (shown !== "finish" && !(shown === "comments" && commentsTabRef.current === "drafts")) openComments("drafts");
  }, [openPanel, openComments]);
  // A pick in an overlay, such as a chapter or a comment to show, closes it: what was picked shows.
  const closeOverlays = useCallback(() => {
    setNavOverlay(false);
    if (layoutRef.current.panel === "overlay") closePanel();
  }, [closePanel]);
  const fullscreen = isFullscreen || covering;
  // BB's own layout switches here: its toasts sit at the top of a narrower window.
  const wideWindow = useMediaQuery("(min-width: 768px)");
  // Without a choice of your own, long lines wrap where the code is narrow, rather than scroll sideways.
  const [chosenWrap, setChosenWrap] = useState(getWrapLines);
  const wrapLines = chosenWrap ?? (layout.mode !== "tablet" || layout.narrowReader);
  const changeWrap = useCallback((wrap: boolean) => { setChosenWrap(wrap); setWrapLines(wrap); }, []);
  const [hideWhitespace, setHideWhitespaceState] = useState(getHideWhitespace);
  const changeHideWhitespace = useCallback((hide: boolean) => { setHideWhitespaceState(hide); setHideWhitespace(hide); }, []);
  // Without a choice of your own, comments in the code fold to markers where the screen is small.
  const [chosenFold, setChosenFold] = useState(getCommentsFolded);
  const commentsFolded = chosenFold ?? layout.mode !== "tablet";
  const changeCommentsFolded = useCallback((folded: boolean) => { setChosenFold(folded); setCommentsFolded(folded); }, []);
  const reducedMotion =
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // Opening the review clears its Needs You alert.
  useEffect(() => { void rpc.call("markSeen", { targetKey }).catch(() => {}); }, [rpc, targetKey]);
  // Unread, the settings are their defaults: a re-review opens on Settings' default.
  const [preferencesFailed, setPreferencesFailed] = useState(false);
  const loadPreferences = useCallback(() => {
    void rpc.call("getPreferences", null).then(setPreferences).catch(() => setPreferencesFailed(true));
  }, [rpc]);
  useEffect(loadPreferences, [loadPreferences]);
  useRealtime("preferences", loadPreferences);
  // The reading layout is a setting, saved for every review like the one in Settings.
  // Below about 960px the diff shows unified whatever the layout, so the toggle can't apply there.
  const [unifiedOnly, setUnifiedOnly] = useState(false);
  const toggleLayout = useCallback(async () => {
    if (!preferences || unifiedOnly) return;
    const next = { ...preferences.preferences, diffLayout: preferences.preferences.diffLayout === "split" ? "unified" as const : "split" as const };
    setPreferences({ ...preferences, preferences: next });
    try {
      setPreferences(await rpc.call("savePreferences", { preferences: next, revision: preferences.revision }));
    } catch {
      toast.error("Couldn’t save the layout.");
      loadPreferences();
    }
  }, [rpc, preferences, unifiedOnly, loadPreferences]);
  // Saved once the first load has picked the page, so the saved chapter isn't lost before it's read.
  useEffect(() => { if (activeId) patchReviewState(targetKey, { activeId }); }, [targetKey, activeId]);
  const isPr = review?.kind === "pr";

  // Only the latest refresh applies: marks made while an older one was out would come undone.
  const loadViews = useCallback(async () => {
    const id = ++viewsRequest.current;
    try {
      const { views } = await rpc.call("getFileViews", { targetKey });
      if (id === viewsRequest.current) setViews(viewMap(views));
    } catch {
      // Non-fatal — the diff just won't show viewed state.
    }
  }, [rpc, targetKey]);

  const load = useCallback(async () => {
    const id = ++request.current;
    const viewsId = ++viewsRequest.current;
    setLoadError(null);
    let settingsWait: ReturnType<typeof setTimeout> | undefined;
    try {
      // Views come with the diff, so viewed files are folded before it first draws.
      const known = shownPatch.current?.targetKey === targetKey ? shownPatch.current : null;
      const [{ review, guide, patch: sent, revision, diffError }, viewsRes, generatedRes, settings] = await Promise.all([
        rpc.call("getReviewBundle", { targetKey, ...(known ? { knownRevision: known.revision } : {}) }),
        rpc.call("getFileViews", { targetKey }).catch(() => null),
        // Like views, so files the repo marks generated are folded before the diff draws.
        rpc.call("getGeneratedFiles", { targetKey }).catch(() => null),
        // Settings, which say where a review that came back opens. A slow or hung load opens it with the defaults.
        Promise.race([settledRef.current.finally(() => clearTimeout(settingsWait)), new Promise<ReviewPreferences>((resolve) => { settingsWait = setTimeout(() => resolve(defaultPreferences), SETTINGS_WAIT_MS); })]),
      ]);
      if (id !== request.current) return;
      // A deleted review shows "Review not found" rather than a pending regeneration.
      if (!review) hasDisplayedGuide.current = false;
      if (!guide && hasDisplayedGuide.current) {
        setGeneratingReplacement(true);
        if (review?.status === "error") setLoadError("Couldn’t regenerate the guide. Your previous view and unsaved edits are still here.");
        return;
      }
      hasDisplayedGuide.current = !!guide;
      setGeneratingReplacement(false);
      const patch = sent ?? known?.patch ?? "";
      shownPatch.current = { targetKey, revision, patch };
      setRevision(revision);
      setReview(review);
      const guideJson = JSON.stringify(guide ?? null);
      if (guideJson !== shownGuide.current) {
        shownGuide.current = guideJson;
        setGuide(guide);
      }
      setPatch(patch);
      if (diffError) setLoadError(diffError);
      if (viewsRes && viewsId === viewsRequest.current) setViews(viewMap(viewsRes.views));
      if (generatedRes) setGenerated((current) => current.size === generatedRes.files.length && generatedRes.files.every((file) => current.has(file)) ? current : new Set(generatedRes.files));
      const chapters = guide?.sections ? withOtherFiles(fitHunks(guide.sections, patch), patch) : [];
      if (!chapters.length) return;
      if (!review || opened.current) {
        // A reload keeps the page, unless its chapter went with the guide it was in.
        setActiveId((prev) => prev === OVERVIEW || chapters.some((section) => section.id === prev) ? prev : OVERVIEW);
        return;
      }
      opened.current = true;
      // The review opens where you left it, or on its Overview: the first time, when its chapter is gone, and when it
      // came back to you since you last opened it, with Comments beside it where there's room, unless Settings → Reading
      // reopens it where you left it.
      const saved = getReviewState(targetKey);
      const turn = review.turn ?? computeTurn(review);
      const back = settings.knobs.returnToOverview && review.kind === "pr" && turn.group === "needs" && FEEDBACK_FIRST.has(turn.reason) && !!turn.signal && turn.signal !== saved.turnSignal;
      const resumable = saved.activeId === OVERVIEW || chapters.some((section) => section.id === saved.activeId);
      const start = !back && resumable ? saved.activeId! : OVERVIEW;
      restoreScroll.current = start === saved.activeId ? { id: start, top: saved.scrollTop ?? 0 } : null;
      restoringPlace.current = !!restoreScroll.current && !!carriedPlace.current;
      setActiveId(start);
      // Before 0.6.0 a review was left on Feedback or Threads, which Comments shows now: once, if it docks. Feedback
      // only once you've reviewed it, as 0.5 did.
      const left = saved.view === "feedback" || saved.view === "threads" ? saved.view : null;
      const tab = back ? "feedback" : left && review.kind === "pr" && (left === "threads" || baselineOf(review).at !== null) ? left : null;
      if (tab) setOpening(tab);
      // Undefined drops the key: the old view is used up.
      patchReviewState(targetKey, { view: undefined, ...(turn.signal ? { turnSignal: turn.signal } : {}) });
    } catch (err) {
      if (id === request.current) setLoadError(err instanceof Error ? err.message : "Check the connection and try again.");
    } finally {
      // A load that failed or was overtaken stops waiting for settings too.
      clearTimeout(settingsWait);
      if (id === request.current) setLoading(false);
    }
  }, [rpc, targetKey]);

  useEffect(() => {
    void load();
    return () => { request.current++; };
  }, [load]);
  useRealtime(`review:${targetKey}`, () => { void load(); });
  // The checks are read again when the sync sees the PR's head or CI state change, not on every reload.
  const checksKey = review?.kind === "pr" ? `${review.latestHeadSha ?? review.headSha ?? ""} ${review.signals?.ci ?? ""}` : null;
  useEffect(() => {
    if (checksKey === null) return;
    let cancelled = false;
    rpc.call("getChecks", { targetKey }).then((result) => { if (!cancelled) setChecks(result); }, () => {});
    return () => { cancelled = true; };
  }, [rpc, targetKey, checksKey]);

  // What changed since your last review, when the diff shown isn't the one you reviewed.
  const baselineSha = review ? baselineOf(review).sha : null;
  const head: string | null = review?.headSha ?? null;
  const rereview = !!baselineSha && baselineSha !== head;
  // Your choice holds at the head you made it at: a new push ends it, and the diff shows Settings' choice again.
  const choice = chosen?.head === head ? chosen : null;
  const compareFrom = choice?.from ?? null;
  const fromSha = compareFrom ?? baselineSha;
  const sinceKey = fromSha && head && fromSha !== head ? `${fromSha}..${head}` : null;
  // Only the comparison read for this one: a push or a pick never shows the last one's, not even for a frame.
  const since = sinceRead?.key === sinceKey ? sinceRead.files : null;
  const sinceError = sinceFailed?.key === sinceKey ? sinceFailed.error : null;
  useEffect(() => {
    if (!sinceKey) return;
    let cancelled = false;
    const failed = (error?: string) => { if (!cancelled) setSinceFailed({ key: sinceKey, error: error ?? "Couldn’t compare with your last review." }); };
    rpc.call("getSinceReview", { targetKey, ...(compareFrom ? { from: compareFrom } : {}) }).then((result) => {
      if (result.error) failed(result.error);
      else if (!cancelled && result.baseline) {
        setSinceRead({ key: sinceKey, files: new Map((result.files as FileInterdiff[]).map((file) => [file.file, file])) });
        setSinceFailed(null);
      }
    }).catch((error) => failed(error instanceof Error ? error.message : undefined));
    return () => { cancelled = true; };
  }, [rpc, targetKey, sinceKey, compareFrom]);
  // Without a choice of yours, a re-review shows Settings' choice: by default only what changed since your review, once
  // anything has. Only a comparison that has arrived narrows the diff.
  const rereviewShows = preferences?.preferences.rereviewShows ?? defaultPreferences.rereviewShows;
  const sinceOnly = !!since && (choice ? choice.narrowed : rereviewShows === "since" && [...since.values()].some((file) => file.status !== "unchanged"));
  // The diff opens on what it compares with: until that's known, where you were in it isn't there to go back to.
  const compared = !sinceKey || !!sinceError || (!!since && (!!choice || !!preferences || preferencesFailed));
  // Kept for the review, and for its next workspace: what you pick narrows the diff once its comparison arrives.
  const choose = useCallback((from: string | null, narrowed: boolean) => {
    if (!head) return;
    const next = { head, from, narrowed };
    setChosen(next);
    patchReviewState(targetKey, { compare: next });
  }, [targetKey, head]);
  // All changes lets a picked commit go.
  const narrow = useCallback((narrowed: boolean) => choose(narrowed ? compareFrom : null, narrowed), [choose, compareFrom]);
  // A flip you make between them (the switch, the band's select, Diff options) keeps your place in the code, read before
  // the diff shows more or fewer files and hunks; null on the chapter's intro, where the code stays put, the files it
  // shows under it.
  const flipFrom = useRef<{ place: FlipPlace | null } | null>(null);
  const flip = useCallback((narrowed: boolean) => {
    const box = scrollBox.current;
    if (box && since && narrowed !== sinceOnly) {
      const intro = box.querySelector(":scope > section");
      const place = !box.scrollTop || (intro && intro.getBoundingClientRect().bottom > box.getBoundingClientRect().top) ? null : flipPlace(box);
      flipFrom.current = { place };
      // What's at the top is current, as after your own scroll.
      if (place) pinned.current = false;
    }
    narrow(narrowed);
  }, [since, sinceOnly, narrow]);
  // Another commit is another comparison, which arrives later: picking the one shown again is a flip.
  const pickCompare = useCallback((sha: string | null) => sha === compareFrom ? flip(true) : choose(sha, true), [compareFrom, flip, choose]);
  const sinceWhat = compareFrom ? compareFrom.slice(0, 7) : "your review";
  // Who owns each file, by CODEOWNERS on a PR's base branch, or a local review's new side.
  // Settings → Reading can turn them off, which takes them away at once.
  const codeOwners = useKnob("codeOwners");
  useEffect(() => {
    if (!revision || !codeOwners) return;
    let cancelled = false;
    rpc.call("getCodeOwners", { targetKey }).then((result) => { if (!cancelled) setOwners(new Map(result.files.map((entry) => [entry.file, entry]))); }, () => {});
    return () => { cancelled = true; };
  }, [rpc, targetKey, revision, codeOwners]);
  const shownOwners = codeOwners ? owners : NO_OWNERS;
  const sections = useMemo(() => guide?.sections ? withOtherFiles(fitHunks(guide.sections, patch), patch) : [], [guide, patch]);
  const lines = useMemo(() => changedLines(patch), [patch]);
  const readLines = useMemo(() => readingLines([...lines.keys()], lines, generated), [lines, generated]);
  const chapterLines = useMemo(() => chapterReadingLines(sections, patch, lines, generated), [sections, patch, lines, generated]);
  // What Finish review asks about when you approve.
  const guardOn = useKnob("approveGuard");
  const pace = useKnob("approveGuardPace");
  const guard = useMemo(() => guardOn ? approveGuard(sections, views, patch, lines, generated, pace) : undefined,
    [sections, views, patch, lines, generated, guardOn, pace]);
  // Whether a chapter's file changed since, and so shows narrowed.
  const texts = useMemo(() => new Map(splitPatchByFile(patch).map((f) => [f.path, f.text])), [patch]);
  const changedIn = useCallback((diff: any) => {
    const change = since?.get(diff.file);
    if (!diff.hunks || change?.status !== "changed") return change?.status === "changed" || change?.status === "added";
    // A split file counts where its hunks changed, or changes gone from it were.
    const text = texts.get(diff.file) ?? "";
    return !!hunksIn(change.patch, filePart(text, diff.hunks)) || !!droppedNear(change.dropped, text, diff.hunks);
  }, [since, texts]);
  const changedSince = useMemo(() => since && sections.length ? Object.fromEntries(sections.map((section: any) => [section.id, section.diffs.filter(changedIn).length])) : undefined, [since, sections, changedIn]);

  const snooze = useCallback(async (snoozed: boolean, until?: number) => {
    setSnoozing(true);
    try {
      const result = await rpc.call("snoozeReview", { targetKey, snoozed, ...(until ? { until } : {}) });
      if (!result.ok) toast.error(result.error ?? "Couldn’t update the review.");
      else void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t update the review.");
    } finally { setSnoozing(false); }
  }, [rpc, targetKey, load]);

  const rebuild = useCallback(async () => {
    if (rebuilding) return;
    setRebuilding(true);
    setLoadError(null);
    try {
      const result = await rpc.call("rereview", { targetKey });
      if (!result.ok) setLoadError(result.error ?? "Couldn’t rebuild the guide.");
      else await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn’t rebuild the guide.");
    } finally { setRebuilding(false); }
  }, [rebuilding, rpc, targetKey, load]);
  const archived = !!review?.archivedAt;
  const { newCommits, text: newCommitsText } = useNewCommits(targetKey, isPr && !archived);

  const checkAccess = useMemo(
    () => async () => {
      try {
        const r = await rpc.call("checkRepoAccess", { targetKey });
        setRepoAccess(r);
      } catch {
        // Non-fatal: access banner just won't show.
      }
    },
    [rpc, targetKey],
  );

  useEffect(() => {
    if (guide) void checkAccess();
  }, [guide, checkAccess]);
  useRealtime("gh-account", () => {
    void checkAccess();
  });

  // Track browser fullscreen state so the toggle icon/label stays correct.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenEnabled) setCovering((value) => !value);
    else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void rootRef.current?.requestFullscreen().catch(() => {});
  }, []);
  const canFullscreen = document.fullscreenEnabled || "showPopover" in HTMLElement.prototype;
  useKeyboardInset(rootEl);
  useSafeArea(rootEl);
  // A tablet's layout in a phone's window held sideways is the unfolded iPhone Duo's: its fold is estimated where the
  // browser can't say where it is.
  useFold(rootEl, layout.mode === "tablet");
  const reanchor = useScrollAnchor(scrollEl);
  // While the step bar is over the code's foot, the code ends above it: a chapter's last buttons stay in reach.
  const commentStep = useCommentStep(targetKey);
  useLayoutEffect(() => {
    if (!covering || !rootEl) return;
    rootEl.setAttribute("popover", "manual");
    // Overlays render inside it, as in browser fullscreen (lib/portal-scope.ts).
    rootEl.setAttribute("data-fullscreen-cover", "");
    rootEl.showPopover();
    return () => {
      rootEl.hidePopover();
      rootEl.removeAttribute("popover");
      rootEl.removeAttribute("data-fullscreen-cover");
    };
  }, [covering, rootEl]);

  const activeIndex = sections.findIndex((x: any) => x.id === activeId);
  const activeSection = activeIndex >= 0 ? sections[activeIndex] : undefined;
  const activeFiles: string[] = useMemo(() => activeSection ? activeSection.diffs.map((d: any) => d.file) : [], [activeSection]);
  const summaries = useMemo(() => new Map<string, string>(activeSection?.diffs.flatMap((d: any) => d.summary ? [[d.file, d.summary]] : []) ?? []), [activeSection]);
  // Files this chapter shares with others: the hunks it shows, and where the rest are.
  const splitFiles = useMemo(() => new Map<string, { hunks: number[]; alsoIn: string[] }>(activeSection?.diffs.flatMap((d: any) => {
    const alsoIn = sections.filter((s: any) => s !== activeSection && s.diffs.some((other: any) => other.file === d.file)).map((s: any) => s.title);
    return d.hunks && alsoIn.length ? [[d.file, { hunks: d.hunks, alsoIn }]] : [];
  }) ?? []), [sections, activeSection]);
  // The chapter you were reading, which the Overview offers to continue.
  const [lastChapter, setLastChapter] = useState<string | undefined>();
  // In the chapter's intro, where the diff puts a re-review's switch.
  const [switchSlot, setSwitchSlot] = useState<HTMLDivElement | null>(null);
  useEffect(() => { if (activeSection) setLastChapter(activeSection.id); }, [activeSection]);

  // Else the first file the reader shows: narrowed, a chapter's first file may be hidden. Showing more or fewer of the
  // same chapter's files, the file at the reader's top, unless a key or click went to one: the one narrowed to may now
  // be its last, and j would go nowhere.
  const filesWere = useRef(activeFiles);
  useEffect(() => {
    const shown = Array.from(scrollBox.current?.querySelectorAll<HTMLElement>("[data-file]") ?? [], (el) => el.dataset.file!);
    const top = filesWere.current === activeFiles && !pinned.current ? fileAtTop() : undefined;
    filesWere.current = activeFiles;
    setCurrentFile((current) => top && shown.includes(top) ? top : current && shown.includes(current) ? current : shown[0]);
  }, [activeFiles, sinceOnly, since]);
  // A file a key or click went to stays current until you scroll yourself: it may not reach the top.
  const pinned = useRef(false);
  const unpin = useCallback(() => { pinned.current = false; }, []);
  // Your first scroll puts the "need you" pill away: Comments' count and the dock's dot still say so.
  const scrolledByYou = useCallback(() => { unpin(); setPill(false); }, [unpin]);
  useEffect(() => {
    if (!opening || !rootEl) return;
    // A frame on, the layout is the workspace's own, not the window's guess.
    const frame = requestAnimationFrame(() => {
      setOpening(null);
      if (layoutRef.current.panelCanDock) {
        setCommentsTab(opening);
        setPanelView("comments");
      } else setPill(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [opening, rootEl]);
  const reviewFiles: string[] = useMemo(() => [...new Set<string>(sections.flatMap((s: any) => s.diffs.map((d: any) => d.file)))], [sections]);

  // Restore the saved scroll position once the page it was saved on shows. The diff draws its files a moment later, so
  // it follows them down until it gets there, for a few seconds, or until you scroll or tap yourself. Meanwhile the
  // browser's scroll anchoring is off: when a diff above the place draws, it would keep what shows on screen, off the
  // place. A remounted workspace goes back to the line that was at the top instead, which a new width wraps elsewhere.
  // Until that line draws, it goes to the line's file: a large chapter draws a file only as it comes near. Either waits
  // for the comparison the diff showed then; meanwhile another chapter, or your own scroll, tap or key, drops it.
  const dropRestore = useCallback(() => { restoreScroll.current = null; carriedPlace.current = null; restoringPlace.current = false; }, []);
  useEffect(() => {
    const box = scrollBox.current;
    const pending = restoreScroll.current;
    if (!pending || !activeId || !box) return;
    if (pending.id !== activeId) return dropRestore();
    if (!compared) return;
    restoreScroll.current = null;
    const top = pending.top;
    const place = carriedPlace.current;
    carriedPlace.current = null;
    if (!top && !place) return;
    let frame = 0;
    let settled = 0;
    const until = Date.now() + 3000;
    const follow = () => {
      if (place) {
        // On its line for a few frames running, as what's above it finishes drawing.
        const off = goToPlace(box, place);
        if (off === null) {
          const file = "file" in place && Array.from(box.querySelectorAll<HTMLElement>("[data-file]")).find((el) => el.dataset.file === place.file);
          // Its file, for it to draw; the saved position, which a new width's wraps put elsewhere, only with the file gone.
          if (file) box.scrollTop += file.getBoundingClientRect().top - box.getBoundingClientRect().top;
          else if (top) box.scrollTop = top;
        }
        settled = off !== null && off < 2 ? settled + 1 : 0;
        if (settled < 6 && Date.now() < until) frame = requestAnimationFrame(follow);
        return;
      }
      box.scrollTop = top;
      if (box.scrollTop < top - 1 && Date.now() < until) frame = requestAnimationFrame(follow);
    };
    box.style.overflowAnchor = "none";
    restoringPlace.current = !!place;
    const stop = () => { restoringPlace.current = false; cancelAnimationFrame(frame); clearTimeout(timer); box.style.overflowAnchor = ""; };
    const timer = setTimeout(stop, until - Date.now());
    const inputs = ["wheel", "touchstart"] as const;
    inputs.forEach((type) => box.addEventListener(type, stop, { once: true }));
    // A tap anywhere, as on a file in a sheet or a comment in the dock, goes where it says.
    window.addEventListener("pointerdown", stop, { capture: true, once: true });
    window.addEventListener("keydown", stop, { once: true });
    follow();
    return () => {
      stop();
      inputs.forEach((type) => box.removeEventListener(type, stop));
      window.removeEventListener("pointerdown", stop, { capture: true });
      window.removeEventListener("keydown", stop);
    };
  }, [activeId, patch, compared, dropRestore]);
  // Also once the page shows: a guide built while the comparison loads sets the place to go back to only then.
  useEffect(() => {
    const box = scrollBox.current;
    if (compared || !box || !restoreScroll.current) return;
    const inputs = ["wheel", "touchstart"] as const;
    inputs.forEach((type) => box.addEventListener(type, dropRestore, { once: true }));
    window.addEventListener("pointerdown", dropRestore, { capture: true, once: true });
    window.addEventListener("keydown", dropRestore, { once: true });
    return () => {
      inputs.forEach((type) => box.removeEventListener(type, dropRestore));
      window.removeEventListener("pointerdown", dropRestore, { capture: true });
      window.removeEventListener("keydown", dropRestore);
    };
  }, [compared, activeId, dropRestore]);
  // Your place after a flip, put back before it paints, then as the files it shows draw, for a few seconds, or until you
  // scroll, tap or press a key. Meanwhile the browser's scroll anchoring is off, as it would keep what shows on screen;
  // Safari has none. Either way, the resize anchor takes what's at the top now: a scrollbar coming or going with the
  // files resizes the box, and it would put back what was at the top before the flip.
  useLayoutEffect(() => {
    const box = scrollBox.current;
    const flipped = flipFrom.current;
    flipFrom.current = null;
    if (!box || !flipped) return;
    const { place } = flipped;
    if (!place) return reanchor();
    let frame = 0;
    const until = Date.now() + 3000;
    const inputs = ["wheel", "touchstart"] as const;
    const stop = () => {
      cancelAnimationFrame(frame);
      clearTimeout(listen);
      box.style.overflowAnchor = "";
      inputs.forEach((type) => box.removeEventListener(type, stop));
      window.removeEventListener("pointerdown", stop, { capture: true });
      window.removeEventListener("keydown", stop);
    };
    const follow = () => {
      goToFlipPlace(box, place);
      if (Date.now() < until) frame = requestAnimationFrame(follow);
      else stop();
    };
    box.style.overflowAnchor = "none";
    // Once the key that flipped it, if one did, has reached the window.
    const listen = setTimeout(() => {
      inputs.forEach((type) => box.addEventListener(type, stop, { once: true }));
      window.addEventListener("pointerdown", stop, { capture: true, once: true });
      window.addEventListener("keydown", stop, { once: true });
    });
    follow();
    reanchor();
    return stop;
  }, [sinceOnly, reanchor]);

  const toggleViewed = useCallback(
    (file: string, viewed: boolean) => {
      setViews((prev) => {
        const next = new Map(prev);
        next.set(file, { viewed, stale: false });
        return next;
      });
      rpc
        .call("setFileViewed", { targetKey, file, viewed })
        .then(() => loadViews())
        .catch(() => loadViews());
    },
    [rpc, targetKey, loadViews],
  );

  // A chapter's files not viewed yet, marked at once. Undo puts each back as it was, changed since you viewed it too.
  const markChapterViewed = useCallback((id: string) => {
    const files: string[] = sections.find((section: any) => section.id === id)?.diffs.map((d: any) => d.file) ?? [];
    const todo = files.filter((f) => !views.get(f)?.viewed);
    if (!todo.length) return;
    const before = new Map(todo.map((f) => [f, views.get(f)]));
    setViews((prev) => {
      const next = new Map(prev);
      for (const f of todo) next.set(f, { viewed: true, stale: false });
      return next;
    });
    const marked = rpc.call("setFilesViewed", { targetKey, files: todo });
    marked.then(() => loadViews()).catch(() => loadViews());
    const undo = () => {
      setViews((prev) => {
        const next = new Map(prev);
        for (const [f, flags] of before) if (flags) next.set(f, flags); else next.delete(f);
        return next;
      });
      // After the marking, with the views it replaced, so the server ends where the screen does.
      void marked
        .then(({ previous }) => rpc.call("setFilesViewed", { targetKey, files: todo, viewed: false, previous }))
        .then(() => loadViews()).catch(() => loadViews());
    };
    toast.success(`Marked ${todo.length} file${todo.length === 1 ? "" : "s"} viewed`, { action: { label: "Undo", onClick: undo } });
  }, [sections, views, rpc, targetKey, loadViews]);
  const foldAllFiles = useCallback((folded: boolean) => setFoldAll({ folded, nonce: Date.now() }), []);

  // A new chapter opens at its top, unless you're jumping to a place in it.
  const jumping = useRef(false);
  const shownChapter = useRef(activeId);
  useEffect(() => {
    if (shownChapter.current === activeId) return;
    const opening = !shownChapter.current;
    shownChapter.current = activeId;
    const keep = opening || jumping.current || !!pendingScroll.current;
    jumping.current = false;
    if (!keep && scrollBox.current) scrollBox.current.scrollTop = 0;
  }, [activeId]);

  // A chapter you choose opens on its intro, with its first file next, even a file you were on in the last chapter.
  const selectChapter = useCallback((id: string) => {
    if (id !== activeId) {
      pinned.current = false;
      setCurrentFile(sections.find((section: any) => section.id === id)?.diffs[0]?.file);
    }
    setActiveId(id);
    closeOverlays();
  }, [activeId, sections, closeOverlays]);

  const registerFileEl = useCallback((file: string, el: HTMLElement | null) => {
    if (el) fileEls.current.set(file, el);
    else fileEls.current.delete(file);
  }, []);

  const scrollToFile = useCallback(
    (file: string) => {
      const el = fileEls.current.get(file);
      if (el) el.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    },
    [reducedMotion],
  );

  // Since your review hides files unchanged since then, a split file's part in a chapter that didn't change, and a changed
  // file's hunks that didn't change: showing one, or a line there, turns the filter off, as All changes does. Says
  // whether it did.
  const unhide = useCallback((file: string, at?: CommentLocation, chapterId?: string) => {
    const change = sinceOnly ? since?.get(file) : undefined;
    const part = sinceOnly && chapterId ? sections.find((section: any) => section.id === chapterId)?.diffs.find((diff: any) => diff.file === file) : undefined;
    const hidden = change?.status === "unchanged" || (!!part && !changedIn(part)) || (!!at && at.line > 0 && change?.status === "changed" && !diffLines(change.patch)(at));
    if (hidden) narrow(false);
    return hidden;
  }, [sinceOnly, since, sections, changedIn, narrow]);

  const onSelectFile = useCallback(
    (chapterId: string, file: string) => {
      const hidden = unhide(file, undefined, chapterId);
      if (chapterId !== activeId) {
        pendingScroll.current = file;
        setActiveId(chapterId);
      } else if (hidden) {
        // It's there once the flip shows it: its top goes to the top then.
        flipFrom.current = { place: { file, after: [], lines: [], offset: 0 } };
      } else {
        scrollToFile(file);
      }
      pinned.current = true;
      setCurrentFile(file);
      closeOverlays();
    },
    [activeId, scrollToFile, unhide, closeOverlays],
  );

  // A comment chosen in Comments: show its line in the diff.
  const showComment = useCallback((at: CommentLocation) => {
    const chapter = chapterAt(sections, patch, at);
    if (!chapter) return;
    unhide(at.file, at);
    if (chapter.id !== activeId) jumping.current = true;
    setActiveId(chapter.id);
    closeOverlays();
    pinned.current = true;
    setCurrentFile(at.file);
    setReveal({ at, nonce: Date.now() });
  }, [sections, patch, activeId, unhide, closeOverlays]);
  // A thread on a file the PR no longer changes has no diff here to show; its GitHub link can show it.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // Leaving the review leaves its full screen: before going, and if it's left some other way, as it goes.
  const leave = useCallback(async (subPath = "") => {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    navigateRef.current.toPluginPanel("review", subPath ? { subPath } : undefined);
  }, []);
  useLayoutEffect(() => {
    if (!rootEl) return;
    return () => { if (rootEl.contains(document.fullscreenElement)) void document.exitFullscreen().catch(() => {}); };
  }, [rootEl]);
  const outsideGuide = useCallback((file: string, url: string | null) => {
    if (sections.some((section: any) => section.diffs.some((diff: any) => diff.file === file))) return false;
    toast.info(`${file} isn’t changed in this PR anymore.`, url ? { action: { label: "Open on GitHub", onClick: () => navigateRef.current.openUrl(url) } } : undefined);
    return true;
  }, [sections]);
  // A line from Comments, a thread, Find or Start here: the whole diff, so the line is there, unless it wasn't narrowed,
  // nor about to be. Without a line, the file.
  const showLocation = useCallback((file: string, line: number | null, side: "LEFT" | "RIGHT", url: string | null = null) => {
    if (outsideGuide(file, url)) return;
    if (sinceOnly || !compared) narrow(false);
    showComment({ file, line: line ?? 0, side });
  }, [outsideGuide, sinceOnly, compared, narrow, showComment]);
  const openHotspot = useCallback((file: string, line: number, side: "LEFT" | "RIGHT") => showLocation(file, line, side), [showLocation]);
  // Find in review's results: a line, a chapter, or a file's summary, in the diff.
  const openFoundFile = useCallback((_chapterId: string, file: string) => showLocation(file, null, "RIGHT"), [showLocation]);
  const followUp = useCallback((file: string, line: number | null, side: "LEFT" | "RIGHT", url: string | null = null) => {
    if (outsideGuide(file, url)) return;
    showLocation(file, line, side);
    if (line != null) setDraftPrefill({ file, line, side, nonce: Date.now() });
  }, [outsideGuide, showLocation]);
  // Finish review shows the draft at its summary, which the draft focuses once it shows.
  const showDraftSummary = useCallback((replaced = false) => { openPanel("finish"); setShowDraft({ at: Date.now(), replaced }); }, [openPanel]);
  // Read when you ask, so asking doesn't change with each scroll, nor the workspace's api with it.
  const currentFileRef = useRef(currentFile);
  currentFileRef.current = currentFile;
  // From the file you're on, or the chapter's start; on the Overview, from the first chapter.
  const nextUnviewed = useCallback(() => {
    const order = readingOrder(sections);
    const placeOf = (file: string | undefined) => order.findIndex((entry) => entry.chapter === activeId && entry.file === file);
    const current = currentFileRef.current;
    const from = Math.max(current ? placeOf(current) : placeOf(activeFiles[0]) - 1, -1);
    const next = [...order.slice(from + 1), ...order.slice(0, from + 1)].find((entry) => !views.get(entry.file)?.viewed);
    if (!next) toast.info("Every file is viewed.");
    else onSelectFile(next.chapter, next.file);
  }, [sections, activeId, activeFiles, views, onSelectFile]);
  const chapterId = activeSection?.id as string | undefined;
  const ask = useCallback((context: AgentMessageContext) => { setInjection({ context, nonce: Date.now() }); openPanel("agent"); }, [openPanel]);
  const askAgent = useCallback((context?: AgentMessageContext) => ask(context ?? { file: currentFileRef.current, chapterId }), [ask, chapterId]);
  const showFeedback = useMemo(() => isPr ? () => openComments("feedback") : undefined, [isPr, openComments]);
  // The diff remounts after the Overview; it shouldn't jump back to an old comment.
  useEffect(() => { if (activeId === OVERVIEW) setReveal(undefined); }, [activeId]);
  // A selection's actions go with the chapter it was made in: a new chapter starts with none, but for the lines a
  // remounted workspace had selected.
  useEffect(() => {
    const lines = activeId ? carriedLines.current : null;
    if (activeId) carriedLines.current = null;
    setLineSel(lines);
  }, [activeId]);

  useEffect(() => {
    if (pendingScroll.current && activeFiles.includes(pendingScroll.current)) {
      const f = pendingScroll.current;
      pendingScroll.current = null;
      requestAnimationFrame(() => scrollToFile(f));
    }
  }, [activeFiles, scrollToFile]);

  // Persist scroll (debounced) and track the file nearest the viewport top.
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollFrame = useRef(0);
  useEffect(() => () => { if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current); cancelAnimationFrame(scrollFrame.current); }, []);
  // The file whose card spans the top of the diff, or else the first one below it.
  const fileAtTop = useCallback(() => {
    const box = scrollBox.current;
    if (!box) return undefined;
    const top = box.getBoundingClientRect().top + 1;
    let below: { file: string; top: number } | undefined;
    for (const [file, el] of fileEls.current) {
      const rect = el.getBoundingClientRect();
      if (rect.top <= top && rect.bottom > top) return file;
      if (rect.top > top && (!below || rect.top < below.top)) below = { file, top: rect.top };
    }
    return below?.file;
  }, []);
  const onScroll = useCallback(() => {
    const box = scrollBox.current;
    if (!box) return;
    // Measuring every file is costly, so at most once a frame.
    if (!scrollFrame.current) scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const best = pinned.current ? undefined : fileAtTop();
      if (best) setCurrentFile(best);
    });
    if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
    const value = box.scrollTop;
    // Putting a remounted workspace's line back, what's at the code's top may be a line above it that the new width
    // unwrapped into view: kept, turning back would put that one there instead. The place is yours to move.
    const restoring = restoringPlace.current;
    scrollSaveTimer.current = setTimeout(() => {
      patchReviewState(targetKey, { scrollTop: value });
      // Under a phone's sheet the code is inert, and gone with the workspace (BB remounting the page) it isn't laid out:
      // what's at its top can't be read, and the place stays the one it was.
      if (!restoring && box.isConnected && !box.closest("[inert]")) keep(targetKey, { place: linePlace(box) });
    }, 200);
  }, [targetKey, fileAtTop]);

  // Everyone's GitHub threads, under their lines in the diff unless hidden, and your feedback and reply drafts: the one
  // reader for the code and Comments, so it keeps reading while Comments shows.
  const diffThreads = useDiffThreads(targetKey, isPr, repoAccess?.account ?? undefined);
  const [showThreads, setShowThreadsState] = useState(getGithubThreadsInCode);
  const setShowThreads = useCallback((show: boolean) => { setShowThreadsState(show); setGithubThreadsInCode(show); }, []);
  // A GitHub thread's line, with the threads on so its card shows there.
  const showThread = useCallback((file: string, line: number | null, side: "LEFT" | "RIGHT", url: string | null = null) => {
    setShowThreads(true);
    showLocation(file, line, side, url);
  }, [setShowThreads, showLocation]);
  const checkFailures = useCheckFailures(targetKey, isPr ? review?.headSha ?? null : null);
  const readContents = useCallback((file: string) => rpc.call("getFileContents", { targetKey, file }), [rpc, targetKey]);

  // GitHub-style line selection in the diff (via pierre) → comment / ask agent.
  const onLineSelected = useCallback((file: string, range: SelectedLineRange | null) => {
    setLineSel(range ? { file, range } : null);
  }, []);

  function commentOnLines(ask = false) {
    if (!lineSel) return;
    const { file, range } = lineSel;
    const side = (range.endSide ?? range.side) === "deletions" ? "LEFT" : "RIGHT";
    setDraftPrefill({ file, line: range.end, side, startLine: range.start, ...(range.side ? { startSide: range.side === "deletions" ? "LEFT" : "RIGHT" } : {}), ask, nonce: Date.now() });
    setLineSel(null);
    // As your first scroll does: the "need you" pill would cover the box's buttons.
    setPill(false);
  }

  // Asking opens a box at the lines, and the agent answers there. An archived
  // review's draft can't change, so its lines are quoted into the chat instead.
  function askAboutLines() {
    if (!lineSel) return;
    if (review?.prState !== "MERGED" && review?.prState !== "CLOSED") return commentOnLines(true);
    const { file, range } = lineSel;
    const side = (range.endSide ?? range.side) === "deletions" ? "deletions" : "additions";
    ask({ file, startLine: range.start, endLine: range.end, side, chapterId });
    setLineSel(null);
  }

  // Keyboard shortcuts, anywhere in the workspace or with nothing focused, except while typing.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const showShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const draftLines = useRef<CommentLocation[]>([]);
  const lastLine = useRef<CommentLocation | null>(null);
  const shortcut = useRef<(key: string) => boolean>(() => false);
  shortcut.current = (key) => {
    const shown = Array.from(scrollBox.current?.querySelectorAll<HTMLElement>("[data-file]") ?? []).map((el) => el.dataset.file!);
    const at = currentFile ? shown.indexOf(currentFile) : -1;
    const goToFile = (file: string | undefined) => {
      if (!file) return;
      pinned.current = true;
      setCurrentFile(file);
      fileEls.current.get(file)?.scrollIntoView({ block: "start" });
    };
    const allFiles = readingOrder(sections);
    const placeOf = (file: string | undefined) => allFiles.findIndex((entry) => entry.chapter === activeId && entry.file === file);
    // The Overview has no files to move between.
    const inChapter = !!activeSection;
    switch (key) {
      case "j": case "k": {
        if (!inChapter) return false;
        // On a chapter's intro the first file is current but not reached yet: j goes to it first.
        const box = scrollBox.current;
        const header = currentFile ? fileEls.current.get(currentFile) : undefined;
        const ahead = key === "j" && !pinned.current && !!box && !!header && box.scrollHeight > box.clientHeight
          && header.getBoundingClientRect().top > box.getBoundingClientRect().top + 1;
        goToFile(shown[ahead ? Math.max(at, 0) : key === "j" ? at + 1 : Math.max(at - 1, 0)]);
        return true;
      }
      case "n": case "p": {
        // The Overview comes before the first chapter.
        const next = key === "n" ? sections[activeIndex + 1]?.id : activeIndex > 0 ? sections[activeIndex - 1].id : activeIndex === 0 ? OVERVIEW : undefined;
        if (next) selectChapter(next);
        return true;
      }
      case "v": {
        const file = shown[Math.max(at, 0)];
        if (!inChapter || !file) return inChapter;
        toggleViewed(file, !views.get(file)?.viewed);
        const after = shown[shown.indexOf(file) + 1];
        requestAnimationFrame(() => goToFile(after));
        return true;
      }
      case "u": nextUnviewed(); return true;
      case "]": case "[": {
        // The Comments list's order and filter, once it registered them; until then, the draft's lines.
        if (stepComment(targetKey, key === "]" ? 1 : -1, currentFile)) return true;
        const lines = inDiffOrder(draftLines.current, sections, patch);
        if (!lines.length) return true;
        // From the line you last went to, or else from the current file.
        const last = lastLine.current ? lines.findIndex((line) => sameLocation(line.at, lastLine.current!)) : -1;
        const here = placeOf(currentFile ?? activeFiles[0]);
        const after = lines.findIndex((line) => line.place >= here);
        const index = last >= 0 ? last + (key === "]" ? 1 : -1) : key === "]" ? Math.max(after, 0) : (after > 0 ? after : lines.length) - 1;
        const next = lines[(index + lines.length) % lines.length].at;
        lastLine.current = next;
        showComment(next);
        return true;
      }
      case "/": case "f": {
        if (key === "f") {
          changeNavView("files");
          // The filter is under Find in review's results while it has a query.
          rootRef.current?.querySelector("[data-find]")?.dispatchEvent(new Event("clearfind"));
          showNav();
          requestAnimationFrame(() => rootRef.current?.querySelector<HTMLInputElement>("[data-filter-box]")?.focus());
        } else findInReview();
        return true;
      }
      case "V": {
        if (activeSection) markChapterViewed(activeSection.id);
        return inChapter;
      }
      case "t": toggleNav(); return true;
      case "c": togglePanel("comments"); return true;
      case "a": askAgent(); return true;
      case "s": showDraftSummary(); return true;
      case "i": changeCommentsFolded(!commentsFolded); return true;
      case "F": {
        if (canFullscreen) toggleFullscreen();
        return canFullscreen;
      }
      case "Escape": {
        // What's over the code, then the iPhone's cover; the browser's full screen leaves on Esc by itself.
        const { nav, panel } = layoutRef.current;
        if (nav === "overlay" || panel === "overlay") closeOverlays();
        else if (covering) setCovering(false);
        else return false;
        return true;
      }
      case "?": setShortcutsOpen(true); return true;
    }
    return false;
  };
  // Settings → Reading can turn the keys off, all but Esc.
  const shortcutsOn = useKnob("singleKeyShortcuts");
  const shortcutsRef = useRef(shortcutsOn);
  shortcutsRef.current = shortcutsOn;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const typed = shortcutKey(event);
      const key = typed === "Escape" || shortcutsRef.current ? typed : null;
      const root = rootRef.current;
      const target = event.target as Element;
      // Its commands in BB's title bar are the review's too: closing what one of them opened gives it the focus.
      const commands = target.closest?.("[data-review-commands]")?.getAttribute("data-review-commands") === targetKey;
      if (!root || (target !== document.body && !root.contains(target) && !commands)) return;
      // An Esc a menu or tooltip already took is theirs.
      if (key === "Escape" && event.defaultPrevented) return;
      // Other keys may scroll the diff, which then says which file you're on.
      if (!key) pinned.current = false;
      else if (shortcut.current(key)) event.preventDefault();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [targetKey]);

  const api = useMemo((): WorkspaceApi | null => guide ? {
    targetKey, review: review ?? { targetKey }, guide, sections, activeId, go: selectChapter, layout,
    nav: { open: layout.nav === "docked" || layout.nav === "overlay", toggle: toggleNav, find: findInReview, view: navView, setView: changeNavView },
    panel: { view: shownPanel, open: openPanel, toggle: togglePanel, close: closePanel },
    files: { views, toggleViewed, markChapterViewed, nextUnviewed, foldAll: foldAllFiles },
    compare: { baseline: baselineSha, head: review?.headSha ?? null, from: compareFrom, pick: pickCompare, since, narrowed: sinceOnly, setNarrowed: flip, error: sinceError, what: sinceWhat },
    display: { layout: diffLayout, toggleLayout, unifiedOnly, wrap: wrapLines, setWrap: changeWrap, hideWhitespace, setHideWhitespace: changeHideWhitespace, githubThreads: showThreads, setGithubThreads: setShowThreads, commentsFolded, setCommentsFolded: changeCommentsFolded },
    reveal: showComment, showLocation, followUp, askAgent, openFinish: showDraftSummary,
    fullscreen: { available: canFullscreen, on: fullscreen, toggle: toggleFullscreen }, leave,
    snooze, newCommits, rebuild, reload: load, pinnable: preferences?.preferences.threadListReviews === true, showShortcuts,
    shortcuts: shortcutsOn,
  } : null, [targetKey, review, guide, sections, activeId, selectChapter, layout, toggleNav, findInReview, navView, changeNavView, shownPanel, openPanel, togglePanel, closePanel, views, toggleViewed, markChapterViewed, nextUnviewed, foldAllFiles, baselineSha, compareFrom, pickCompare, flip, since, sinceOnly, sinceError, sinceWhat, diffLayout, toggleLayout, unifiedOnly, wrapLines, changeWrap, hideWhitespace, changeHideWhitespace, showThreads, setShowThreads, commentsFolded, changeCommentsFolded, showComment, showLocation, followUp, askAgent, showDraftSummary, canFullscreen, fullscreen, toggleFullscreen, leave, snooze, newCommits, rebuild, load, preferences, showShortcuts, shortcutsOn]);

  if (!guide || !api) {
    const back = () => navigate.toPluginPanel("review");
    if (loadError) return <ReviewError title="Couldn’t load this review" message={loadError} onRetry={() => void load()} onBack={back} />;
    if (loading) return <ReviewSkeleton />;
    if (!review) return <ReviewError title="Review not found" message="This review may have been removed. Return to your reviews or refresh the connection." onRetry={() => void load()} onBack={back} primary="back" />;
    if (review.status === "tracked") return <TrackedReview review={review} onBack={back} />;
    if (review.status === "error") return <ReviewError review={review} onRetry={() => void rebuild()} onBack={back} busy={rebuilding} />;
    return <ReviewSkeleton review={review} onBack={back} />;
  }

  const noticeButton = cn("h-7", TOUCH_CONTROL);
  // The most pressing first: what went wrong, then what's under way, then what you might do.
  const notices: Notice[] = [
    ...(loadError ? [{ id: "load", tone: "danger", icon: "AlertCircle", role: "alert", text: loadError, action: <Button variant="outline" size="sm" className={noticeButton} onClick={() => void load()}>Try again</Button> }] as const : []),
    ...(review?.status === "error" ? [{ id: "rebuild", tone: "danger", icon: "AlertTriangle", role: "alert", text: "Couldn’t update the guide. Showing the previous one.", action: <Button variant="outline" size="sm" className={noticeButton} disabled={rebuilding} onClick={() => void rebuild()}>Try again</Button> }] as const : []),
    ...(repoAccess && !repoAccess.accessible ? [{ id: "access", tone: "danger", icon: "Lock", text: `${repoAccess.account ? `@${repoAccess.account}` : "Your GitHub account"} can’t access ${repoAccess.repo ?? "this repo"}. Switch account:`, action: <AccountBar /> }] as const : []),
    ...(generatingReplacement ? [{ id: "updating", tone: "warning", icon: "Loading", busy: true, text: "Updating the guide for the new commits. Your current view and unsaved edits stay here." }] as const : []),
    ...(review?.skippedRun && !archived ? [{ id: "not-run", tone: "warning", icon: "Lock", label: "Not run automatically", text: `${notRunReason(review)}.`, action: <NotRunButton review={review} /> }] as const : []),
    ...(newCommits && !generatingReplacement ? [{ id: "new-commits", tone: "info", icon: "GitCommit", text: newCommitsText, action: <Button variant="outline" size="sm" className={noticeButton} disabled={rebuilding} onClick={() => void rebuild()}>Update guide</Button> }] as const : []),
  ];
  // Inside the padding that keeps the workspace clear of the screen's edges.
  const rootStyle = rootEl && getComputedStyle(rootEl);
  const paneWidth = rootEl && rootStyle ? rootEl.clientWidth - (parseFloat(rootStyle.paddingLeft) || 0) - (parseFloat(rootStyle.paddingRight) || 0) : 0;
  // A phone's sides are its one sheet, over the code, which shows nothing else to reach meanwhile.
  const sheet = layout.mode === "phone";
  const sheetOpen = sheet && (layout.nav === "overlay" || layout.panel === "overlay");

  return (
    <WorkspaceProvider api={api}>
    {/* The draft's provider shares it with the diff, which shows each comment under its line, and with its panel. */}
    <DraftProvider patch={patch} reviewRevision={revision} rebuilding={generatingReplacement} ownPr={review?.ownPr === true} approveGuard={guard} account={repoAccess?.account ?? undefined} onOpenPanel={openDraftView} review={review} onSubmitted={() => { void load(); }} isLocal={review?.kind === "ref"} targetKey={targetKey} activeChapterId={activeId} activeFiles={activeFiles} files={reviewFiles} prefill={draftPrefill} showDraft={showDraft}>
    {/* Kit popovers open as bottom drawers where the workspace is phone-sized or short. */}
    <CompactViewportOverrideProvider isCompactViewport={layout.mode !== "tablet"}>
    {/* It keeps clear of the screen's edges where it reaches them (--gr-safe-*: the notch, the Duo's rail, the home
        indicator, which a phone's dock keeps clear of at the bottom), and ends above a keyboard over it (--gr-kb). */}
    <div
      ref={(el) => {
        rootRef.current = el;
        setRootEl(el);
      }}
      className={cn("@container/review relative flex h-full min-h-0 min-w-0 flex-col bg-background pt-[var(--gr-safe-top,0px)] pr-[var(--gr-safe-right,0px)] pl-[var(--gr-safe-left,0px)]", sheet ? "pb-[var(--gr-kb,0px)]" : "pb-[max(var(--gr-safe-bottom,0px),var(--gr-kb,0px))]", covering && "fixed inset-0 m-0 h-auto w-auto overflow-hidden border-0 text-foreground")}
      style={{ backgroundColor: "rgb(from var(--background) r g b / 1)" }}
    >
      <div className="relative flex min-h-0 flex-1">
        <NavigatorHost targetKey={targetKey} placement={layout.nav} sheet={sheet} sheetTitle={<ChapterViewSwitch view={navView} onChange={changeNavView} />} sheetActions={<><DiffOptions threads={isPr && diffThreads.threads.length > 0} /><ReviewMenu api={api} className={cn("size-8 px-0", TOUCH_CONTROL)} /></>} width={navWidth} maxWidth={Math.min(NAV_WIDTH.max, paneWidth - READER_MIN - (layout.panel === "docked" ? panelDockWidth(paneWidth, panelWidth) : 0))} onWidth={setNavWidth} onWidthDone={saveNavWidth} onClose={() => setNavOverlay(false)}>
          <Navigator leading={<TopBand />} patch={patch} currentFile={currentFile} changedSince={changedSince} lines={lines} generated={generated} threads={diffThreads.threads} owners={shownOwners} onSelect={selectChapter} onSelectFile={onSelectFile} onOpenLine={showLocation} onOpenFile={openFoundFile} initialFind={carry?.find} onFind={keepFind} />
        </NavigatorHost>
        <main aria-label="Review" inert={sheetOpen} className="flex min-w-0 flex-1 flex-col">
          {/* With the keyboard up leaving a phone held sideways' room or less, the band and notices give way to the code. */}
          <div className="contents [[data-keyboard=short]_&]:hidden">
            <ReaderBar threads={isPr && diffThreads.threads.length > 0} onCompareShown={setCompareShown} />
            <ReviewNotices notices={notices} />
          </div>
          {/* A spacer, not top padding: padding would hold sticky file headers 16px down, with code showing above them. */}
          <div ref={(el) => { scrollBox.current = el; setScrollEl(el); }} onScroll={onScroll} onWheel={scrolledByYou} onTouchMove={scrolledByYou} onPointerDown={unpin} className={cn("min-h-0 flex-1 overflow-y-auto px-4 before:block before:h-4 before:content-['']", commentStep ? "pb-24" : "pb-6")}>
            {activeSection ? (
              <>
              <ChapterIntro key={activeSection.id} collapsedByDefault={layout.mode === "short"} brief={layout.mode !== "tablet"} index={activeIndex} total={sections.length} title={activeSection.title} overview={activeSection.overview} risk={activeSection.risk} focus={activeSection.focus} lines={chapterLines.get(activeSection.id) ?? 0} switchSlot={setSwitchSlot} />
              <CheckFailuresContext.Provider value={checkFailures}>
              <DiffThreadsContext.Provider value={showThreads ? diffThreads : null}>
              <DiffViewer
                diffLayout={diffLayout}
                wrapLines={wrapLines}
                hideWhitespace={hideWhitespace}
                themeMode={codeTheme.mode}
                patch={patch}
                files={activeFiles}
                summaries={summaries}
                splitFiles={splitFiles}
                views={views}
                onToggleViewed={toggleViewed}
                registerFileEl={registerFileEl}
                onLineSelected={onLineSelected}
                selectedLines={lineSel}
                reveal={reveal}
                since={since}
                sinceOnly={sinceOnly}
                showRemoved={activeId === sections.at(-1)?.id}
                onUnifiedOnly={setUnifiedOnly}
                readContents={readContents}
                generated={generated}
                sinceWhat={sinceWhat}
                owners={shownOwners}
                foldAll={foldAll}
                onSinceOnly={rereview || sheet || !compareShown ? flip : undefined}
                switchSlot={switchSlot}
              />
              </DiffThreadsContext.Provider>
              </CheckFailuresContext.Provider>
              <ChapterFooter patch={patch} />
              </>
            ) : <ReviewOverview checks={checks} readLines={readLines} changedSince={changedSince} generated={generated} snoozing={snoozing} resume={lastChapter} onShowFeedback={showFeedback} onOpenLine={openHotspot} />}
          </div>
        </main>
        <SidePanel targetKey={targetKey} placement={layout.panel} sheet={sheet} view={shownPanel} width={panelWidth} maxWidth={Math.min(PANEL_WIDTH.max, paneWidth - READER_MIN - (layout.nav === "docked" ? navWidth : 0))} onWidth={setPanelWidth} onWidthDone={savePanelWidth} onClose={closePanel} onBack={() => { openPanel("comments"); focusComments(targetKey); }}>
          <CommentsView shown={shownPanel === "comments" || shownPanel === "finish"} finish={shownPanel === "finish"} tab={commentsTab} onTab={setCommentsTab} revision={revision} onShowThread={showThread} />
          <FinishView shown={shownPanel === "finish"} revision={revision} />
          <AgentDock targetKey={targetKey} patch={patch} injection={injection} container={rootEl} active={shownPanel === "agent"} popOut={layout.mode === "tablet"} closeLabel={sheet ? "Close" : undefined} onDock={() => openPanel("agent")} onCollapse={closePanel} />
        </SidePanel>
        {/* Over the code, a side dims the rest; a tap there closes it. */}
        {(layout.nav === "overlay" || layout.panel === "overlay") && <div aria-hidden className="absolute inset-0 z-30 bg-black/40 animate-in fade-in duration-200 motion-reduce:animate-none" onClick={() => { setNavOverlay(false); if (layout.panel === "overlay") closePanel(); }} />}
      </div>
      {sheet && <PhoneDock hidden={!!lineSel} />}
      <DraftLines into={draftLines} />

      <StepBar hidden={!!lineSel} pill={pill} />
      <SelectionBar lines={lineSel} phone={sheet} onComment={() => commentOnLines()} onAskLines={askAboutLines} onClear={() => setLineSel(null)} />
      <ShortcutsHelp open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {/* In full screen the workspace is over the page, BB's toaster under it: sonner is BB's, so a toaster of its own
          here shows the same toasts, Undo's among them, where BB's does: at the top under 768px wide. */}
      {fullscreen && <Toaster theme={codeTheme.mode} position={wideWindow ? "bottom-right" : "top-center"} />}
    </div>
    </CompactViewportOverrideProvider>
    </DraftProvider>
    </WorkspaceProvider>
  );
});
ReviewWorkspace.displayName = "ReviewWorkspace";
