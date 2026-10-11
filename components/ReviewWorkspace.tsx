import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useRpc, useRealtime, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { SelectedLineRange } from "@pierre/diffs";
import type { rpcContract } from "../src/rpc-contract";
import { VERDICT_LABEL, sameLocation, type CommentLocation } from "../src/draft";
import type { FileInterdiff } from "../src/interdiff";
import { baselineOf, computeTurn, type TurnReason } from "../lib/turn";
import { cn } from "../lib/utils";
import { experimental_useCodeTheme } from "@get-bb/plugin-sdk/app";
import { useMediaQuery } from "./ui/hooks/use-media-query";
import { getHideWhitespace, getReviewState, getWrapLines, patchReviewState, setHideWhitespace, setLastReview, setWrapLines } from "../lib/panel-state";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { ReviewHeader, ReviewTitleLink } from "./ReviewHeader";
import { ChapterNav } from "./ChapterNav";
import { ChapterIntro } from "./ChapterIntro";
import { DiffViewer, type FileViewFlags } from "./DiffViewer";
import { DraftTray, type CommentPrefill } from "./DraftTray";
import { RereviewBanner } from "./RereviewBanner";
import { ThreadsPanel } from "./ThreadsPanel";
import { FeedbackPanel } from "./FeedbackPanel";
import { TrackedReview } from "./TrackedReview";
import type { DockInjection } from "./AgentDock";
import { ReviewSkeleton, ReviewError } from "./ReviewSkeleton";
import { kindLook } from "./ReviewStatus";
import { IconTile } from "./ui/icon-tile";
import { InlineCode } from "./ui/inline-code";
import { Hint } from "./ui/hint";
import { ReviewActions } from "./ReviewActions";
import { AccountBar } from "./AccountBar";
import { defaultPreferences, type ReviewPreferences } from "../lib/review-preferences";
import { useDraftStatus } from "../lib/draft-status";
import { inDiffOrder, shortcutKey } from "../lib/review-shortcuts";
import { InlineDraftContext } from "./InlineDraft";
import { DiffThreadsContext, useDiffThreads } from "./LineThreads";
import { CheckFailuresContext, useCheckFailures } from "./CheckFailures";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { StartHere } from "./StartHere";
import { splitPatchByFile } from "../src/patch";
import { changedLines, readingLines } from "../lib/review-size";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 560;

type View = "diff" | "feedback" | "threads";
const VIEW_LOOK = { diff: { label: "Diff", icon: "FileDiff" }, feedback: { label: "Feedback", icon: "ChatFeedback" }, threads: { label: "Threads", icon: "MessageSquare" } } as const;

/** The guide's chapters, then any changed files they don't list, such as an older guide's unplaced files. */
function withOtherFiles(sections: any[], patch: string): any[] {
  const placed = new Set(sections.flatMap((section) => section.diffs.map((diff: any) => diff.file)));
  const other = splitPatchByFile(patch).map((f) => f.path).filter((path) => !placed.has(path));
  // A guide can have its own Other files chapter, for the files it left unplaced.
  const id = sections.some((section) => section.id === OTHER_FILES) ? `${OTHER_FILES}-unlisted` : OTHER_FILES;
  return other.length ? [...sections, { id, title: "Other files", overview: "Changed files the guide doesn’t place in a chapter.", diffs: other.map((file) => ({ file })) }] : sections;
}
const OTHER_FILES = "other-files";

function viewMap(views: { file: string; viewed: boolean; stale: boolean }[]): Map<string, FileViewFlags> {
  return new Map(views.map((v) => [v.file, { viewed: v.viewed, stale: v.stale }]));
}

/** Hands the workspace the lines with draft comments or discussions, which the draft panel provides. */
function DraftLines({ into }: { into: MutableRefObject<CommentLocation[]> }) {
  const draft = useContext(InlineDraftContext);
  useEffect(() => { into.current = [...(draft?.comments ?? []), ...(draft?.discussions ?? [])]; }, [draft, into]);
  return null;
}

/** Turns where what matters first is whether the author addressed your feedback. */
const FEEDBACK_FIRST = new Set<TurnReason>(["re-requested", "handled", "looks-ready", "question", "mentioned"]);
function opensOnFeedback(review: any): boolean {
  if (review?.kind !== "pr") return false;
  const turn = review.turn ?? computeTurn(review);
  return turn.group === "needs" && FEEDBACK_FIRST.has(turn.reason);
}

/** Where GitHub puts it: what your draft would submit, opening Draft review at its summary. */
function SubmitReviewButton({ targetKey, onOpen }: { targetKey: string; onOpen: () => void }) {
  const status = useDraftStatus(targetKey);
  if (!status) return null;
  const detail = [VERDICT_LABEL[status.verdict], status.comments ? `${status.comments} comment${status.comments === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  return (
    <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={onOpen}>
      <Icon name="Github" className="size-4" aria-hidden />Submit review
      <span className="hidden text-xs text-subtle-foreground @min-[640px]/review:inline">· {detail}</span>
    </Button>
  );
}

export const ReviewWorkspace = memo(function ReviewWorkspace({ targetKey }: { targetKey: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const codeTheme = experimental_useCodeTheme();
  const compactViewport = useMediaQuery("(max-width: 767px)");
  const shortViewport = useMediaQuery("(max-height: 499px)");
  const [mobileChapters, setMobileChapters] = useState(false);
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
  const resizeCleanup = useRef<(() => void) | null>(null);
  const persisted = useMemo(() => getReviewState(targetKey), [targetKey]);

  const [review, setReview] = useState<any>(null);
  const [guide, setGuide] = useState<any>(null);
  const [patch, setPatch] = useState("");
  const [checks, setChecks] = useState<{ bucket: string; checks: any[] } | null>(null);
  // From the saved state, so persisting before the guide loads doesn't overwrite it.
  const [activeId, setActiveId] = useState(persisted.activeId ?? "");
  // The reviewer's choice persists; without one, the review's turn picks the first view once.
  const [chosenView, setView] = useState<View | null>(persisted.view ?? null);
  const [defaultView, setDefaultView] = useState<View | null>(null);
  const [revision, setRevision] = useState("");
  const [repoAccess, setRepoAccess] = useState<{ accessible: boolean; repo: string | null; account: string | null } | null>(null);
  const [views, setViews] = useState<Map<string, FileViewFlags>>(new Map());
  const [generated, setGenerated] = useState<Set<string>>(new Set());
  const [injection, setInjection] = useState<DockInjection | undefined>();
  const [currentFile, setCurrentFile] = useState<string | undefined>();
  const [sel, setSel] = useState<{ x: number; y: number; file: string; code: string } | null>(null);
  const [lineSel, setLineSel] = useState<{ file: string; range: SelectedLineRange } | null>(null);
  const [draftPrefill, setDraftPrefill] = useState<CommentPrefill | undefined>();
  const [showDraft, setShowDraft] = useState<{ at: number; replaced?: boolean } | undefined>();
  const [since, setSince] = useState<Map<string, FileInterdiff> | null>(null);
  const [sinceError, setSinceError] = useState<string | null>(null);
  const [sinceOnly, setSinceOnly] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [reveal, setReveal] = useState<{ at: CommentLocation; nonce: number }>();

  // Screen utilization: resizable/collapsible sidebar, focus mode, fullscreen.
  const [sidebarWidth, setSidebarWidth] = useState(persisted.sidebarWidth ?? 288);
  const [chosenSidebarCollapsed, setSidebarCollapsed] = useState<boolean | null>(null);
  const [chosenFocus, setFocus] = useState(persisted.focus);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const fileEls = useRef<Map<string, HTMLElement>>(new Map());
  const pendingScroll = useRef<string | null>(null);
  const scrollBox = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  // Compact by the workspace's own width: a narrow BB pane on a wide screen is as tight as a phone.
  // Short by its height, as on a phone held sideways. Only whether: the size changes every frame of a pane drag.
  const [narrowRoot, setNarrowRoot] = useState<boolean | null>(null);
  const [shortRoot, setShortRoot] = useState<boolean | null>(null);
  useEffect(() => {
    if (!rootEl || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setNarrowRoot(entry.contentRect.width < 768);
      setShortRoot(entry.contentRect.height < 500);
    });
    observer.observe(rootEl);
    return () => observer.disconnect();
  }, [rootEl]);
  const compact = narrowRoot ?? compactViewport;
  const short = shortRoot ?? shortViewport;
  // Without a choice of your own, Focus gives a compact or short workspace's diff the room,
  // and a short one starts with the chapters hidden, so code shows on open.
  const focus = chosenFocus ?? (compact || short);
  const sidebarCollapsed = chosenSidebarCollapsed ?? short;
  // Likewise long lines wrap there, rather than scroll sideways.
  const [chosenWrap, setChosenWrap] = useState(getWrapLines);
  const wrapLines = chosenWrap ?? compact;
  const [hideWhitespace, setHideWhitespaceState] = useState(getHideWhitespace);
  const didRestoreScroll = useRef(false);
  const reducedMotion =
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => setLastReview(targetKey), [targetKey]);
  // Opening the review clears its Needs You alert.
  useEffect(() => { void rpc.call("markSeen", { targetKey }).catch(() => {}); }, [rpc, targetKey]);
  const loadPreferences = useCallback(() => {
    void rpc.call("getPreferences", null).then(setPreferences).catch(() => {});
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
  useEffect(() => patchReviewState(targetKey, { activeId, view: chosenView ?? undefined, sidebarWidth, focus: chosenFocus }), [targetKey, activeId, chosenView, sidebarWidth, chosenFocus]);
  const isPr = review?.kind === "pr";
  const view: View = chosenView && chosenView !== "diff" && review && !isPr ? "diff" : chosenView ?? defaultView ?? "diff";

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
    try {
      // Views come with the diff, so viewed files are folded before it first draws.
      const known = shownPatch.current?.targetKey === targetKey ? shownPatch.current : null;
      const [{ review, guide, patch: sent, revision, diffError }, viewsRes, generatedRes] = await Promise.all([
        rpc.call("getReviewBundle", { targetKey, ...(known ? { knownRevision: known.revision } : {}) }),
        rpc.call("getFileViews", { targetKey }).catch(() => null),
        // Like views, so files the repo marks generated are folded before the diff draws.
        rpc.call("getGeneratedFiles", { targetKey }).catch(() => null),
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
      if (review) setDefaultView((current) => current ?? (opensOnFeedback(review) ? "feedback" : "diff"));
      const guideJson = JSON.stringify(guide ?? null);
      if (guideJson !== shownGuide.current) {
        shownGuide.current = guideJson;
        setGuide(guide);
      }
      setPatch(patch);
      if (diffError) setLoadError(diffError);
      if (viewsRes && viewsId === viewsRequest.current) setViews(viewMap(viewsRes.views));
      if (generatedRes) setGenerated((current) => current.size === generatedRes.files.length && generatedRes.files.every((file) => current.has(file)) ? current : new Set(generatedRes.files));
      const chapters = guide?.sections ? withOtherFiles(guide.sections, patch) : [];
      if (chapters.length) {
        const saved = getReviewState(targetKey).activeId;
        setActiveId((prev) => chapters.some((section) => section.id === prev)
          ? prev : chapters.some((section) => section.id === saved) ? saved! : chapters[0].id);
      }
    } catch (err) {
      if (id === request.current) setLoadError(err instanceof Error ? err.message : "Check the connection and try again.");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [rpc, targetKey]);

  useEffect(() => {
    void load();
    return () => { request.current++; resizeCleanup.current?.(); };
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
  const sinceKey = baselineSha && review?.headSha && baselineSha !== review.headSha ? `${baselineSha}..${review.headSha}` : null;
  useEffect(() => {
    setSince(null);
    setSinceError(null);
    if (!sinceKey) return;
    let cancelled = false;
    const failed = (error?: string) => { if (!cancelled) setSinceError(error ?? "Couldn’t compare with your last review."); };
    rpc.call("getSinceReview", { targetKey }).then((result) => {
      if (result.error) failed(result.error);
      else if (!cancelled && result.baseline) setSince(new Map((result.files as FileInterdiff[]).map((file) => [file.file, file])));
    }).catch((error) => failed(error instanceof Error ? error.message : undefined));
    return () => { cancelled = true; };
  }, [rpc, targetKey, sinceKey]);
  useEffect(() => { if (!since) setSinceOnly(false); }, [since]);
  const sections = useMemo(() => guide?.sections ? withOtherFiles(guide.sections, patch) : [], [guide, patch]);
  const lines = useMemo(() => changedLines(patch), [patch]);
  const readLines = useMemo(() => readingLines([...lines.keys()], lines, generated), [lines, generated]);
  const changedSince = useMemo(() => {
    if (!since || !sections.length) return undefined;
    return Object.fromEntries(sections.map((section: any) => [section.id, section.diffs.filter((diff: any) => {
      const status = since.get(diff.file)?.status;
      return status === "changed" || status === "added";
    }).length]));
  }, [since, sections]);

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

  async function rebuild() {
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
  }

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
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else if (rootRef.current?.requestFullscreen) void rootRef.current.requestFullscreen().catch(() => {});
  }, []);

  const activeIndex = sections.findIndex((x: any) => x.id === activeId);
  const activeSection = activeIndex >= 0 ? sections[activeIndex] : undefined;
  const activeFiles: string[] = useMemo(() => activeSection ? activeSection.diffs.map((d: any) => d.file) : [], [activeSection]);
  const summaries = useMemo(() => new Map<string, string>(activeSection?.diffs.flatMap((d: any) => d.summary ? [[d.file, d.summary]] : []) ?? []), [activeSection]);

  useEffect(() => {
    setCurrentFile((current) => current && activeFiles.includes(current) ? current : activeFiles[0]);
  }, [activeFiles]);
  // A file a key or click went to stays current until you scroll yourself: it may not reach the top.
  const pinned = useRef(false);
  const unpin = useCallback(() => { pinned.current = false; }, []);
  const reviewFiles: string[] = useMemo(() => sections.flatMap((s: any) => s.diffs.map((d: any) => d.file)), [sections]);

  // Restore the saved scroll position once the diff has content to scroll.
  useEffect(() => {
    if (didRestoreScroll.current || !patch || view !== "diff" || !scrollBox.current) return;
    const top = getReviewState(targetKey).scrollTop;
    if (top) scrollBox.current.scrollTop = top;
    didRestoreScroll.current = true;
  }, [patch, view, targetKey]);

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

  const markAllViewed = useCallback(() => {
    const todo = activeFiles.filter((f) => !views.get(f)?.viewed);
    if (!todo.length) return;
    setViews((prev) => {
      const next = new Map(prev);
      for (const f of todo) next.set(f, { viewed: true, stale: false });
      return next;
    });
    rpc
      .call("setFilesViewed", { targetKey, files: todo })
      .then(() => loadViews())
      .catch(() => loadViews());
  }, [activeFiles, views, rpc, targetKey, loadViews]);

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

  // With no chapter of your own, a review back with changes opens on the first chapter that changed.
  const pickChangedChapter = useRef(!persisted.activeId);
  useEffect(() => {
    if (!changedSince || !pickChangedChapter.current) return;
    pickChangedChapter.current = false;
    const changed = sections.find((section: any) => changedSince[section.id] > 0);
    if (changed) setActiveId(changed.id);
  }, [changedSince, sections]);
  const selectChapter = useCallback((id: string) => {
    pickChangedChapter.current = false;
    setActiveId(id);
    setMobileChapters(false);
  }, []);

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

  // Since your review hides files unchanged since then; showing one turns the filter off.
  const unhide = useCallback((file: string) => {
    if (since?.get(file)?.status === "unchanged") setSinceOnly(false);
  }, [since]);

  const onSelectFile = useCallback(
    (chapterId: string, file: string) => {
      pickChangedChapter.current = false;
      unhide(file);
      if (chapterId !== activeId) {
        pendingScroll.current = file;
        setActiveId(chapterId);
      } else {
        scrollToFile(file);
      }
      pinned.current = true;
      setCurrentFile(file);
      setMobileChapters(false);
    },
    [activeId, scrollToFile, unhide],
  );

  // A comment chosen in the draft panel: show its line in the diff.
  const showComment = useCallback((at: CommentLocation) => {
    const chapter = sections.find((section: any) => section.diffs.some((diff: any) => diff.file === at.file));
    if (!chapter) return;
    setView("diff");
    unhide(at.file);
    pickChangedChapter.current = false;
    if (chapter.id !== activeId) jumping.current = true;
    setActiveId(chapter.id);
    setMobileChapters(false);
    pinned.current = true;
    setCurrentFile(at.file);
    setReveal({ at, nonce: Date.now() });
  }, [sections, activeId, unhide]);
  // A thread on a file the PR no longer changes has no diff here to show; its GitHub link can show it.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const outsideGuide = useCallback((file: string, url: string | null) => {
    if (sections.some((section: any) => section.diffs.some((diff: any) => diff.file === file))) return false;
    toast.info(`${file} isn’t changed in this PR anymore.`, url ? { action: { label: "Open on GitHub", onClick: () => navigateRef.current.openUrl(url) } } : undefined);
    return true;
  }, [sections]);
  // A line from the Feedback view: the whole diff, so the line is there. Without a line, the file.
  const showLocation = useCallback((file: string, line: number | null, side: "LEFT" | "RIGHT", url: string | null = null) => {
    if (outsideGuide(file, url)) return;
    setSinceOnly(false);
    showComment({ file, line: line ?? 0, side });
  }, [outsideGuide, showComment]);
  const openHotspot = useCallback((file: string, line: number) => showLocation(file, line, "RIGHT"), [showLocation]);
  const followUp = useCallback((file: string, line: number | null, side: "LEFT" | "RIGHT", url: string | null = null) => {
    if (outsideGuide(file, url)) return;
    showLocation(file, line, side);
    if (line != null) setDraftPrefill({ file, line, side, nonce: Date.now() });
  }, [outsideGuide, showLocation]);
  const showDraftSummary = useCallback((replaced = false) => setShowDraft({ at: Date.now(), replaced }), []);
  const askAgent = useCallback(() => setInjection({ context: { file: currentFile, chapterId: activeId }, nonce: Date.now() }), [currentFile, activeId]);
  const openSettings = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    navigate.toPluginPanel("review", { subPath: `settings/${targetKey}` });
  };
  const showFeedback = useMemo(() => isPr ? () => setView("feedback") : undefined, [isPr]);
  const snoozeFromHeader = useMemo(() => isPr ? (snoozed: boolean, until?: number) => void snooze(snoozed, until) : undefined, [isPr, snooze]);
  const archived = !!review?.archivedAt;
  const headerTrailing = useMemo(() => !archived && <RereviewBanner targetKey={targetKey} />, [archived, targetKey]);
  // The diff remounts after Threads; it shouldn't jump back to an old comment.
  useEffect(() => { if (view !== "diff") setReveal(undefined); }, [view]);
  // A selection's actions go with the chapter and view it was made in.
  useEffect(() => { setSel(null); setLineSel(null); }, [activeId, view]);

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
    // The popover sits where the text was.
    setSel(null);
    if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
    const value = box.scrollTop;
    scrollSaveTimer.current = setTimeout(() => patchReviewState(targetKey, { scrollTop: value }), 200);
  }, [targetKey, fileAtTop]);

  const onMouseUp = useCallback(() => {
    const s = window.getSelection();
    const text = s?.toString() ?? "";
    if (!text.trim() || !s || s.rangeCount === 0) {
      setSel(null);
      return;
    }
    const range = s.getRangeAt(0);
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 3 ? node.parentElement : (node as HTMLElement);
    const fileEl = el?.closest("[data-file]") as HTMLElement | null;
    // Text in a draft comment or the comment box isn't code to ask about.
    if (!fileEl || el?.closest("[data-draft-at]")) {
      setSel(null);
      return;
    }
    const r = range.getBoundingClientRect();
    setSel({ x: r.left + r.width / 2, y: r.top, file: fileEl.dataset.file!, code: text.slice(0, 4000) });
  }, []);

  function askAboutSelection() {
    if (!sel) return;
    setInjection({ context: { file: sel.file, code: sel.code, chapterId: activeId }, nonce: Date.now() });
    setSel(null);
    window.getSelection()?.removeAllRanges();
  }

  // Everyone's GitHub threads, under their lines in the diff unless hidden.
  const diffThreads = useDiffThreads(targetKey, isPr && view === "diff");
  const [showThreads, setShowThreads] = useState(true);
  // A GitHub thread's line, with the threads on so its card shows there.
  const showThread = useCallback((file: string, line: number | null, side: "LEFT" | "RIGHT", url: string | null = null) => {
    setShowThreads(true);
    showLocation(file, line, side, url);
  }, [showLocation]);
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
  }

  // Asking opens a box at the lines, and the agent answers there. An archived
  // review's draft can't change, so its lines are quoted into the chat instead.
  function askAboutLines() {
    if (!lineSel) return;
    if (review?.prState !== "MERGED" && review?.prState !== "CLOSED") return commentOnLines(true);
    const { file, range } = lineSel;
    const side = (range.endSide ?? range.side) === "deletions" ? "deletions" : "additions";
    setInjection({
      context: { file, startLine: range.start, endLine: range.end, side, chapterId: activeId },
      nonce: Date.now(),
    });
    setLineSel(null);
  }

  // Keyboard shortcuts, anywhere in the workspace or with nothing focused, except while typing.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
    const allFiles: string[] = sections.flatMap((section: any) => section.diffs.map((diff: any) => diff.file));
    const diffOnly = view === "diff";
    switch (key) {
      case "j": case "k": {
        if (!diffOnly) return false;
        // On a chapter's intro the first file is current but not reached yet: j goes to it first.
        const box = scrollBox.current;
        const header = currentFile ? fileEls.current.get(currentFile) : undefined;
        const ahead = key === "j" && !pinned.current && !!box && !!header && box.scrollHeight > box.clientHeight
          && header.getBoundingClientRect().top > box.getBoundingClientRect().top + 1;
        goToFile(shown[ahead ? Math.max(at, 0) : key === "j" ? at + 1 : Math.max(at - 1, 0)]);
        return true;
      }
      case "n": case "p": {
        const next = sections[activeIndex + (key === "n" ? 1 : -1)];
        if (diffOnly && next) selectChapter(next.id);
        return diffOnly;
      }
      case "v": {
        const file = shown[Math.max(at, 0)];
        if (!diffOnly || !file) return diffOnly;
        toggleViewed(file, !views.get(file)?.viewed);
        const after = shown[shown.indexOf(file) + 1];
        requestAnimationFrame(() => goToFile(after));
        return true;
      }
      case "u": {
        const from = Math.max(currentFile ? allFiles.indexOf(currentFile) : allFiles.indexOf(activeFiles[0]) - 1, -1);
        const rest = [...allFiles.slice(from + 1), ...allFiles.slice(0, from + 1)];
        const file = rest.find((f) => !views.get(f)?.viewed);
        const chapter = file && sections.find((section: any) => section.diffs.some((diff: any) => diff.file === file));
        if (!file || !chapter) toast.info("Every file is viewed.");
        else { setView("diff"); onSelectFile(chapter.id, file); }
        return true;
      }
      case "]": case "[": {
        const lines = inDiffOrder(draftLines.current, allFiles);
        if (!lines.length) return true;
        // From the line you last went to, or else from the current file.
        const last = lastLine.current ? lines.findIndex((line) => sameLocation(line, lastLine.current!)) : -1;
        const here = allFiles.indexOf(currentFile ?? activeFiles[0]);
        const after = lines.findIndex((line) => allFiles.indexOf(line.file) >= here);
        const index = last >= 0 ? last + (key === "]" ? 1 : -1) : key === "]" ? Math.max(after, 0) : (after > 0 ? after : lines.length) - 1;
        const next = lines[(index + lines.length) % lines.length];
        lastLine.current = next;
        showComment(next);
        return true;
      }
      case "a": askAgent(); return true;
      case "s": showDraftSummary(); return true;
      case "?": setShortcutsOpen(true); return true;
    }
    return false;
  };
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const key = shortcutKey(event);
      const root = rootRef.current;
      if (!root || (event.target !== document.body && !root.contains(event.target as Node))) return;
      // Other keys may scroll the diff, which then says which file you're on.
      if (!key) pinned.current = false;
      else if (shortcut.current(key)) event.preventDefault();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Sidebar resize drag.
  function startSidebarResize(e: React.PointerEvent) {
    e.preventDefault();
    resizeCleanup.current?.();
    const startX = e.clientX;
    const startW = sidebarWidth;
    function onMove(ev: PointerEvent) {
      const w = Math.min(Math.max(startW + (ev.clientX - startX), SIDEBAR_MIN), SIDEBAR_MAX);
      setSidebarWidth(w);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      resizeCleanup.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    resizeCleanup.current = onUp;
  }

  if (!guide) {
    const back = () => navigate.toPluginPanel("review");
    if (loadError) return <ReviewError title="Couldn’t load this review" message={loadError} onRetry={() => void load()} onBack={back} />;
    if (loading) return <ReviewSkeleton />;
    if (!review) return <ReviewError title="Review not found" message="This review may have been removed. Return to your reviews or refresh the connection." onRetry={() => void load()} onBack={back} />;
    if (review.status === "tracked") return <TrackedReview review={review} onBack={back} />;
    if (review.status === "error") return <ReviewError onRetry={() => void rebuild()} onBack={back} busy={rebuilding} />;
    return <ReviewSkeleton />;
  }

  const viewedCount = activeFiles.filter((f) => views.get(f)?.viewed).length;
  const nextSection = activeIndex >= 0 ? sections[activeIndex + 1] : undefined;

  return (
    <div
      ref={(el) => {
        rootRef.current = el;
        setRootEl(el);
      }}
      className="@container/review flex h-full min-h-0 min-w-0 flex-col bg-background"
      style={{ backgroundColor: "rgb(from var(--background) r g b / 1)" }}
    >
      {loadError && <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive-text"><Icon name="AlertCircle" className="size-4 shrink-0" aria-hidden /><span className="min-w-0 flex-1">{loadError}</span><Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button></div>}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1"><Button variant="ghost" size="sm" className="gap-1.5 px-2 text-muted-foreground" onClick={() => navigate.toPluginPanel("review")}><Icon name="ChevronLeft" className="size-4" aria-hidden /> All reviews</Button><div className="ml-auto flex flex-wrap items-center gap-1"><SubmitReviewButton targetKey={targetKey} onOpen={() => showDraftSummary()} />{!compact && <><Button variant="ghost" size="sm" className="text-muted-foreground" onClick={askAgent}><Icon name="Sparkles" className="size-4 text-(--ansi-13)" aria-hidden /> Ask agent</Button><Button variant="ghost" size="sm" className="text-muted-foreground" onClick={openSettings}><Icon name="Settings" className="size-4" aria-hidden /> Settings</Button></>}<ReviewActions review={review} className="size-8" items={compact ? [{ label: "Ask agent", icon: "Sparkles", onSelect: askAgent }, { label: "Settings", icon: "Settings", onSelect: openSettings }] : undefined} onChanged={() => void load()} onDeleted={() => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); navigate.toPluginPanel("review"); }} /></div></div>
      {/* Header — full when reviewing normally, slim in focus mode. */}
      {focus ? (
        <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-3 py-2">
          <IconTile {...kindLook(review ?? { targetKey })} className="size-6 rounded-md" iconClassName="size-3.5" />
          <span className="flex min-w-0 flex-1 text-sm font-medium text-foreground">
            <ReviewTitleLink url={review?.url}>{review?.title ?? guide.title ?? targetKey}</ReviewTitleLink>
          </span>
          {generatingReplacement && <p role="status" className="flex items-center gap-1.5 text-xs text-warning-text"><Icon name="Loading" className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />Regenerating the guide. Your previous diff and unsaved edits remain visible.</p>}
          {!review?.archivedAt && <RereviewBanner targetKey={targetKey} />}
        </div>
      ) : (
        <div className="border-b border-border">
          <div className="px-4 pb-3.5 pt-3">
            <ReviewHeader review={review} checks={checks} intent={guide.intent} sinceReview={guide.sinceReview} onShowFeedback={showFeedback} onSnooze={snoozeFromHeader} snoozing={snoozing} readLines={readLines} trailing={headerTrailing} />
            {guide.hotspots?.length > 0 && <StartHere hotspots={guide.hotspots} onOpen={openHotspot} />}
          </div>
          {generatingReplacement && <p role="status" className="flex items-center gap-2 border-t border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning-text"><Icon name="Loading" className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />Regenerating the guide. Your previous diff and unsaved edits remain visible.</p>}
        </div>
      )}
      {repoAccess && !repoAccess.accessible && (
        <p className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/10 px-4 py-1.5 text-xs text-destructive-text">
          <Icon name="Lock" className="size-3.5 shrink-0" aria-hidden />
          <span>Active GitHub account {repoAccess.account ? `@${repoAccess.account}` : ""} can’t access{" "}
          {repoAccess.repo ?? "this repo"}. Switch account:</span>
          <AccountBar />
        </p>
      )}
      {review?.status === "error" && (
        <p className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/10 px-4 py-1.5 text-xs text-destructive-text">
          <Icon name="AlertTriangle" className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">Re-review failed — showing the previous guide.</span>
          <Button variant="outline" size="sm" className="h-7" disabled={rebuilding} onClick={() => void rebuild()}>Retry</Button>
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col @min-[1024px]/review:flex-row">
      {/* The draft panel owns the draft and shares it with the diff, which shows each comment under its line. */}
      <DraftTray patch={patch} reviewRevision={revision} rebuilding={generatingReplacement} ownPr={review?.ownPr === true} account={repoAccess?.account ?? undefined} agent={{ patch, injection, container: rootEl }} review={review} onSubmitted={() => { void load(); }} onShowComment={showComment} isLocal={review?.kind === "ref"} targetKey={targetKey} activeChapterId={activeId} activeFiles={activeFiles} files={reviewFiles} prefill={draftPrefill} showDraft={showDraft}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col @min-[768px]/review:flex-row">
        {(compact ? mobileChapters : !sidebarCollapsed) && (
          <>
            <aside
              className="max-h-[40vh] shrink-0 overflow-y-auto border-b border-border bg-surface-raised p-2 @min-[768px]/review:max-h-none @min-[768px]/review:border-b-0"
              style={{ width: compact ? "100%" : sidebarWidth }}
            >
              <ChapterNav
                sections={sections}
                activeId={activeId}
                onSelect={selectChapter}
                views={views}
                onSelectFile={onSelectFile}
                currentFile={currentFile}
                changedSince={changedSince}
                lines={lines}
                generated={generated}
              />
            </aside>
            {!compact && <div
              tabIndex={0}
              aria-valuemin={SIDEBAR_MIN}
              aria-valuemax={SIDEBAR_MAX}
              aria-valuenow={sidebarWidth}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                setSidebarWidth((width) => event.key === "Home" ? SIDEBAR_MIN : event.key === "End" ? SIDEBAR_MAX : Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width + (event.key === "ArrowRight" ? 20 : -20))));
              }}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              onPointerDown={startSidebarResize}
              className="group/sep relative w-px shrink-0 cursor-col-resize bg-border before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-[''] after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:bg-primary/70 after:opacity-0 after:transition-opacity after:content-[''] hover:after:opacity-100 focus-visible:outline-none focus-visible:after:w-1 focus-visible:after:bg-primary focus-visible:after:opacity-100"
            />}
          </>
        )}
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              aria-label={(compact ? !mobileChapters : sidebarCollapsed) ? "Show chapters" : "Hide chapters"}
              aria-pressed={compact ? mobileChapters : !sidebarCollapsed}
              className="h-9 px-1.5 text-muted-foreground aria-pressed:text-primary md:h-7"
              onClick={() => compact ? setMobileChapters((value) => !value) : setSidebarCollapsed(!sidebarCollapsed)}
            >
              <Icon name="PanelLeft" className="size-4" aria-hidden />
              {compact && "Chapters"}
            </Button>
            <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted/40 p-0.5 ring-1 ring-inset ring-border">
              {/* A local review has nothing on GitHub, so only its diff. */}
              {(isPr ? (["diff", "feedback", "threads"] as const) : (["diff"] as const)).map((value) => (
                <Button
                  key={value}
                  variant="ghost"
                  size="sm"
                  aria-pressed={view === value}
                  className="h-9 gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground aria-pressed:shadow-xs md:h-7"
                  onClick={() => setView(value)}
                >
                  <Icon name={VIEW_LOOK[value].icon} className="size-3.5" aria-hidden />
                  {VIEW_LOOK[value].label}
                </Button>
              ))}
            </div>
            {view === "diff" && since && (
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={sinceOnly}
                className="h-9 gap-1.5 px-2 text-xs text-muted-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:bg-primary/15 md:h-7"
                onClick={() => setSinceOnly((value) => !value)}
              >
                <Icon name="GitCommit" className="size-3.5" aria-hidden />
                Since your review
              </Button>
            )}
            {view === "diff" && sinceError && (
              <span role="status" title={sinceError} className="flex items-center gap-1.5 text-xs text-destructive-text">
                <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden />
                Couldn’t compare with your last review
              </span>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground md:ml-auto">
              {view === "diff" && activeFiles.length > 0 && (
                <>
                  {/* A compact toolbar keeps to the counts and icons. */}
                  <span className={cn("tabular-nums", viewedCount === activeFiles.length && "text-diff-added")}>{viewedCount}/{activeFiles.length}{compact ? <span className="sr-only"> in this chapter</span> : " in this chapter"}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 px-2 text-xs md:h-7"
                    disabled={viewedCount === activeFiles.length}
                    onClick={markAllViewed}
                  >
                    <Icon name="CircleCheck" className="size-3.5" aria-hidden />
                    <span className={cn(compact && "sr-only")}>Mark chapter viewed</span>
                  </Button>
                  <span className="h-4 w-px bg-border" />
                </>
              )}
              {view === "diff" && isPr && diffThreads.threads.length > 0 && <Hint label="GitHub threads" container={rootEl}>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="GitHub threads"
                  aria-pressed={showThreads}
                  className="h-9 px-2 text-xs aria-pressed:text-primary md:h-7"
                  onClick={() => setShowThreads(!showThreads)}
                >
                  <Icon name="Github" className="size-3.5" aria-hidden />
                  <span className="hidden @min-[1280px]/review:inline">Threads</span>
                </Button>
              </Hint>}
              {/* A compact workspace always shows the diff unified. */}
              {view === "diff" && !compact && <Hint label={unifiedOnly ? "Split view needs a wider pane" : "Split view"} container={rootEl}>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Split view"
                  aria-pressed={diffLayout === "split" && !unifiedOnly}
                  aria-disabled={unifiedOnly}
                  className="h-9 px-2 text-xs aria-pressed:text-primary aria-disabled:cursor-default aria-disabled:opacity-50 md:h-7"
                  onClick={() => void toggleLayout()}
                >
                  <Icon name="Columns2" className="size-3.5" aria-hidden />
                  <span className="hidden @min-[1280px]/review:inline">Split</span>
                </Button>
              </Hint>}
              {view === "diff" && <Hint label="Wrap lines" container={rootEl}>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Wrap lines"
                  aria-pressed={wrapLines}
                  className="h-9 px-2 text-xs aria-pressed:text-primary md:h-7"
                  onClick={() => { setChosenWrap(!wrapLines); setWrapLines(!wrapLines); }}
                >
                  <Icon name="TextWrap" className="size-3.5" aria-hidden />
                  <span className="hidden @min-[1280px]/review:inline">Wrap</span>
                </Button>
              </Hint>}
              {view === "diff" && <Hint label="Hide whitespace" container={rootEl}>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Hide whitespace"
                  aria-pressed={hideWhitespace}
                  className="h-9 px-2 text-xs aria-pressed:text-primary md:h-7"
                  onClick={() => { setHideWhitespaceState(!hideWhitespace); setHideWhitespace(!hideWhitespace); }}
                >
                  <Icon name="Space" className="size-3.5" aria-hidden />
                  {/* A longer label, so only where the toolbar has room for it beside the others. */}
                  <span className="hidden @min-[1600px]/review:inline">Hide whitespace</span>
                </Button>
              </Hint>}
              <Hint label="Focus mode" container={rootEl}>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Focus mode"
                  aria-pressed={focus}
                  className="h-9 px-2 text-xs aria-pressed:text-primary md:h-7"
                  onClick={() => setFocus(!focus)}
                >
                  <Icon name="Minimize2" className="size-3.5" aria-hidden />
                  <span className="hidden @min-[1280px]/review:inline">Focus</span>
                </Button>
              </Hint>
              <Hint label={isFullscreen ? "Exit full screen" : "Full screen"} container={rootEl}>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
                  aria-pressed={isFullscreen}
                  className="h-9 px-2 text-xs aria-pressed:text-primary md:h-7"
                  onClick={toggleFullscreen}
                >
                  <Icon name={isFullscreen ? "Minimize2" : "Maximize2"} className="size-3.5" aria-hidden />
                  <span className="hidden @min-[1280px]/review:inline">{isFullscreen ? "Exit" : "Full screen"}</span>
                </Button>
              </Hint>
            </div>
          </div>
          {/* A spacer, not top padding: padding would hold sticky file headers 16px down, with code showing above them. */}
          <div ref={scrollBox} onScroll={onScroll} onMouseUp={onMouseUp} onWheel={unpin} onTouchMove={unpin} onPointerDown={unpin} className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 before:block before:h-4 before:content-['']">
            {view === "diff" ? (
              <>
              {activeSection && <ChapterIntro key={activeSection.id} collapsedByDefault={short} index={activeIndex} total={sections.length} title={activeSection.title} overview={activeSection.overview} risk={activeSection.risk} />}
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
              />
              </DiffThreadsContext.Provider>
              </CheckFailuresContext.Provider>
              {/* After the last chapter, what's next is the review itself. */}
              {activeSection && (
                <div className="mt-6 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
                  {viewedCount < activeFiles.length && (
                    <Button variant="outline" size="sm" onClick={() => { markAllViewed(); if (nextSection) selectChapter(nextSection.id); else showDraftSummary(); }}>
                      <Icon name="CircleCheck" className="size-3.5" aria-hidden />
                      {nextSection ? "Mark chapter viewed and continue" : "Mark chapter viewed and finish"}
                    </Button>
                  )}
                  <Button variant={viewedCount < activeFiles.length ? "ghost" : "soft"} size="sm" className="min-w-0 max-w-full" onClick={() => nextSection ? selectChapter(nextSection.id) : showDraftSummary()}>
                    <span className="truncate">{nextSection ? <>Next: <InlineCode text={nextSection.title} /></> : `Done: ${isPr ? "Submit review" : "open Draft review"}`}</span>
                    <Icon name="ArrowRight" className="size-3.5" aria-hidden />
                  </Button>
                </div>
              )}
              </>
            ) : view === "feedback" ? (
              <FeedbackPanel
                targetKey={targetKey}
                review={review}
                revision={revision}
                onShowLocation={showThread}
                onFollowUp={followUp}
                onDraftUpdated={showDraftSummary}
              />
            ) : (
              <ThreadsPanel targetKey={targetKey} onShowInDiff={showThread} />
            )}
          </div>
        </main>
      </div>
      <DraftLines into={draftLines} />
      </DraftTray>
      </div>

      {/* Line-selection action bar — GitHub-style: pick lines, then act. */}
      {lineSel && (
        <div className="fixed bottom-24 left-1/2 z-[62] flex w-max max-w-[calc(100vw-24px)] -translate-x-1/2 flex-wrap items-center gap-1.5 rounded-xl border border-border bg-popover px-2 py-1.5 text-xs shadow-2xl ring-1 ring-primary/10">
          <span className="flex items-center gap-1.5 px-1 font-mono text-[11px] text-muted-foreground">
            <Icon name="File" className="size-3.5" aria-hidden />
            {lineSel.file.split("/").pop()}
            <span className="rounded bg-primary/10 px-1 text-primary">
              L{lineSel.range.start}
              {lineSel.range.end !== lineSel.range.start ? `–${lineSel.range.end}` : ""}
            </span>
          </span>
          <span className="h-4 w-px bg-border" />
          <Button size="sm" variant="ghost" className="h-9 gap-1.5 px-2 text-xs md:h-7" onClick={() => commentOnLines()}>
            <Icon name="MessageSquarePlus" className="size-3.5 text-primary" aria-hidden />
            Add comment
          </Button>
          <Button size="sm" variant="ghost" className="h-9 gap-1.5 px-2 text-xs md:h-7" onClick={askAboutLines}>
            <Icon name="Sparkles" className="size-3.5 text-(--ansi-13)" aria-hidden />
            Ask agent
          </Button>
          <button
            type="button"
            aria-label="Clear selection"
            onClick={() => setLineSel(null)}
            className="rounded-md p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
          >
            <Icon name="X" className="size-3.5" aria-hidden />
          </button>
        </div>
      )}

      <ShortcutsHelp open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      {sel && (
        <button
          type="button"
          onClick={askAboutSelection}
          className="fixed z-[62] flex -translate-x-1/2 -translate-y-full items-center gap-1.5 rounded-lg bg-(--ansi-13) px-2.5 py-1 text-xs font-semibold text-background shadow-lg hover:brightness-110"
          style={{ left: sel.x, top: sel.y - 6 }}
        >
          <Icon name="Sparkles" className="size-3.5" aria-hidden />
          Ask agent about this
        </button>
      )}

    </div>
  );
});
ReviewWorkspace.displayName = "ReviewWorkspace";
