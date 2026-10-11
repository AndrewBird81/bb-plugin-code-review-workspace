import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { ReviewItem } from "../lib/review-state";
import { commentsKey, isSummary, linesOf, rangeOf, sameLocation, summaryChanges, SUMMARY_AT, VERDICT_LABEL, verdictPicked, type CommentLocation, type Discussion, type Draft, type DraftComment, type Verdict } from "../src/draft";
import { diffPositions, orderRange } from "../src/review-positions";
import { Button, buttonVariants } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Icon } from "./ui/icon";
import { ReviewerNotes } from "./ReviewerNotes";
import { cn } from "../lib/utils";
import { AgentDock, type AgentDockProps } from "./AgentDock";
import { getReviewState, patchReviewState } from "../lib/panel-state";
import { readDraftRecovery, updateDraftRecovery } from "../lib/draft-recovery";
import { setDraftStatus } from "../lib/draft-status";
import { usePortalScopeProps } from "../lib/portal-scope";
import { CommentBody, ComposerNotes, composerKeys, InlineComposerContext, InlineDraftContext, locationKey, type InlineComposer, type InlineDraft } from "./InlineDraft";
import { SummaryCard } from "./SummaryCard";
import { FixHandoff } from "./FixHandoff";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { Badge } from "./ui/badge";
import { FilePath } from "./ui/file-path";

/**
 * A request from the diff to comment on a line, or with `ask` to message the agent about it; the box
 * opens there. `startLine` and `startSide` are the other end of a selection, in either order.
 */
export interface CommentPrefill { file: string; line: number; side: "LEFT" | "RIGHT"; startLine?: number; startSide?: "LEFT" | "RIGHT"; ask?: boolean; nonce: number; }

const OWN_PR = "This is your PR, so GitHub allows only a Comment review.";
const RECEIPT_LABEL: Record<Verdict, string> = { APPROVE: "Approved", REQUEST_CHANGES: "Changes requested", COMMENT: "Commented" };
const VERDICTS = [
  ["APPROVE", "aria-pressed:bg-success/15 aria-pressed:text-diff-added aria-pressed:ring-success/30 aria-pressed:hover:bg-success/20"],
  ["COMMENT", "aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:ring-primary/30 aria-pressed:hover:bg-primary/20"],
  ["REQUEST_CHANGES", "aria-pressed:bg-warning/15 aria-pressed:text-warning-text aria-pressed:ring-warning/30 aria-pressed:hover:bg-warning/20"],
] as const;

export const DraftTray = memo(function DraftTray({ targetKey, activeChapterId, activeFiles, files = activeFiles, prefill, isLocal = false, review, onSubmitted, onShowComment, agent, reviewRevision, rebuilding = false, ownPr = false, account, showDraft, patch = "", children }: {
  targetKey: string; activeChapterId: string; activeFiles: string[];
  /** The review's diff, to order a selection's lines and fill in a suggested change. */
  patch?: string;
  /** The review's changed files, chapter by chapter. */
  files?: string[];
  prefill?: CommentPrefill; isLocal?: boolean; review?: ReviewItem; onSubmitted?: () => void; onShowComment?: (at: CommentLocation) => void;
  reviewRevision?: string; account?: string;
  /** The guide is rebuilding for new commits: comments and submit wait for the new diff. */
  rebuilding?: boolean;
  /** The signed-in account wrote the PR, so GitHub allows only a Comment review. */
  ownPr?: boolean;
  /** A new value opens Draft review at its summary. `replaced`: you agreed the assistant's suggestion replaces your summary. */
  showDraft?: { at: number; replaced?: boolean };
  agent?: Omit<AgentDockProps, "targetKey" | "active" | "onDock" | "onCollapse">;
  /** The diff, which shows the draft's comments under their lines. */
  children?: ReactNode;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState<Draft>({ targetKey, verdict: "COMMENT", body: "", comments: [] });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  // The status line: the draft is saved, being saved, or why the last save or submit failed.
  const [status, setStatus] = useState<{ saving?: true; error?: string }>({});
  // A chapter with no files starts the form on the review's first file.
  const firstFile = activeFiles[0] ?? files[0] ?? "";
  const [file, setFile] = useState(firstFile);
  const [line, setLine] = useState("1");
  const [side, setSide] = useState<"LEFT" | "RIGHT">("RIGHT");
  const [body, setBody] = useState("");
  const [showComposer, setShowComposer] = useState(false);
  const [editing, setEditing] = useState<DraftComment | null>(null);
  // Whether the open comment box is in the diff rather than this panel.
  const [inline, setInline] = useState(false);
  // Whether the box's text is a message to the agent rather than a comment, and the first of the lines it's about, when several.
  const [asking, setAsking] = useState(false);
  const [startLine, setStartLine] = useState<number | undefined>();
  // The first line's side, when the lines start on the other side (DraftComment startSide).
  const [startSide, setStartSide] = useState<"LEFT" | "RIGHT" | undefined>();
  // Why the server refused the comment in the box; it clears when you change the comment.
  const [composerError, setComposerError] = useState<string | null>(null);
  // The save was refused because the box's text was written against an older diff, such as before a rebuild finished.
  const [olderDiff, setOlderDiff] = useState(false);
  useEffect(() => { setComposerError(null); setOlderDiff(false); }, [file, line, side, body, showComposer]);
  function keepOnCurrentDiff() { composerRevision.current = revisionRef.current; setOlderDiff(false); }
  const [stale, setStale] = useState<CommentLocation[]>([]);
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [writeAnother, setWriteAnother] = useState(false);
  const [receipt, setReceipt] = useState<Verdict | null>(null);
  // Submit asked whether you're sure; any change to the draft asks again.
  const [confirming, setConfirming] = useState(false);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const draftKey = `${draft.verdict}\0${draft.body}\0${commentsKey(draft.comments)}`;
  useEffect(() => setConfirming(false), [draftKey]);
  // The review this panel posted, on GitHub.
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [tab, setTab] = useState<"draft" | "notes" | "agent">(() => {
    const saved = getReviewState(targetKey).activeTool;
    return saved === "notes" || saved === "agent" && agent ? saved : "draft";
  });
  // On a narrow screen the open panel crowds out the diff, so it starts collapsed there, and that isn't saved.
  const [narrow] = useState(() => window.matchMedia?.("(max-width: 767px)").matches ?? false);
  const [toolsOpen, setToolsOpen] = useState(() => !narrow && getReviewState(targetKey).toolsOpen !== false);
  const panelId = useId();
  const railRef = useRef<HTMLDivElement>(null);
  const scopeProps = usePortalScopeProps();
  useEffect(() => { patchReviewState(targetKey, { activeTool: tab, ...(narrow ? {} : { toolsOpen }) }); }, [targetKey, tab, toolsOpen, narrow]);
  useEffect(() => { if (agent?.injection) { setTab("agent"); setToolsOpen(true); } }, [agent?.injection]);
  function collapse() {
    setToolsOpen(false);
    railRef.current?.querySelector<HTMLButtonElement>(`[data-tool="${tab}"]`)?.focus();
  }
  function selectTool(next: typeof tab) {
    if (toolsOpen && tab === next) collapse();
    else { setTab(next); setToolsOpen(true); }
  }
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // What had focus when the box opened, for focus to return to when it's cancelled.
  const opener = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const mounted = useRef(true);
  const lock = useRef(false);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const revisionRef = useRef(reviewRevision); revisionRef.current = reviewRevision;
  const composerRevision = useRef(reviewRevision);
  const shownComments = useRef(draft.comments); shownComments.current = draft.comments;
  // The box is on the review summary rather than a line; it says so, rather than its location fields.
  const [summaryBox, setSummaryBox] = useState(false);
  const onSummary = showComposer && summaryBox;
  // The summary as the box opened on it, to tell when it changes underneath.
  const summaryBase = useRef<string | null>(null);
  // A verdict you picked that the server hasn't confirmed; refreshes don't put the old one back meanwhile.
  const pendingVerdict = useRef<Verdict | null>(null);
  // Summary text kept from before the summary had its own box, until the box is free.
  const legacySummary = useRef<{ body: string; revision?: string } | null>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const focusSummary = () => requestAnimationFrame(() => summaryRef.current?.focus());

  useEffect(() => {
    if (!loaded) return;
    updateDraftRecovery(targetKey, { composer: body ? { file, line, side, body, revision: composerRevision.current, inline, ...(asking ? { asking } : {}), ...(startLine ? { startLine } : {}), ...(startSide ? { startSide } : {}), ...(summaryBox ? { summary: true } : {}) } : undefined });
  }, [loaded, targetKey, file, line, side, body, inline, asking, startLine, startSide, summaryBox]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => { if (body.trim()) event.preventDefault(); };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [body]);

  const enqueue = useCallback(<T,>(operation: () => Promise<T>) => {
    const next = writes.current.catch(() => {}).then(operation);
    writes.current = next;
    return next;
  }, []);

  /** Show the draft as the server has it. The comment box keeps its own text, and a verdict you just picked stays. */
  const apply = useCallback((next: { draft: Draft; stale?: CommentLocation[]; discussions?: Discussion[] }) => {
    if (!mounted.current) return;
    setDraft(pendingVerdict.current ? { ...next.draft, verdict: pendingVerdict.current, verdictChosen: true } : next.draft);
    setStale(next.stale ?? []);
    setDiscussions(next.discussions ?? []);
  }, []);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const result = await rpc.call("getDraft", { targetKey });
      if (!mounted.current) return;
      apply(result as { draft: Draft; stale?: CommentLocation[]; discussions?: Discussion[] });
      const recovered = readDraftRecovery(targetKey);
      if (recovered.composer) {
        const comment = recovered.composer;
        composerRevision.current = comment.revision;
        setFile(comment.file); setLine(comment.line); setSide(comment.side); setBody(comment.body); setInline(comment.inline === true); setShowComposer(true);
        setAsking(comment.asking === true); setStartLine(comment.startLine); setStartSide(comment.startSide); setSummaryBox(comment.summary === true);
        summaryBase.current = comment.summary ? (result.draft as Draft).body : null;
        setEditing(comment.asking || comment.summary ? null : (result.draft as Draft).comments.find((c) => sameLocation(c, { file: comment.file, line: Number(comment.line), side: comment.side })) ?? null);
      }
      if (recovered.summary) {
        legacySummary.current = recovered.summary;
        toast.info("Your unsaved summary from before this update opens once you finish the comment you’re writing.");
      }
      setLoaded(true);
    } catch {
      if (mounted.current) setLoadError(true);
    }
  }, [rpc, targetKey, apply]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);
  // The review assistant, `bb review`, or another window changed the draft while it's open.
  const refresh = useCallback(() => {
    void enqueue(() => rpc.call("getDraft", { targetKey })).then((result) => apply(result as { draft: Draft })).catch(() => {});
  }, [enqueue, rpc, targetKey, apply]);
  useRealtime(`draft:${targetKey}`, refresh);
  useEffect(() => {
    if (!showDraft) return;
    setTab("draft"); setToolsOpen(true);
    // You agreed the suggestion replaces the summary you were writing.
    if (showDraft.replaced) latest.current.dropSummaryEdit();
    // Focusing the summary scrolls it into view.
    focusSummary();
    refresh();
  }, [showDraft, refresh]);

  useEffect(() => { if (!showComposer && !body.trim()) setFile(firstFile); }, [firstFile, showComposer, body]);
  /**
   * Open the comment box, in the diff or this panel, on a line's comment if it has one, or on the
   * summary (SUMMARY_AT); with `ask`, a box for a message to the agent. An unfinished comment or message is shown instead.
   */
  function openComposer(selected: (CommentLocation & Pick<CommentPrefill, "startLine" | "startSide">) | null, inDiff: boolean, ask = false) {
    const writing = !!body.trim();
    if (writing) toast.info(asking ? "Send or cancel your message to the agent first." : onSummary ? "Save or cancel the summary you’re writing first." : "Finish or cancel the comment you’re writing first.");
    else {
      opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      // Lines selected upward, or across sides, start at their first line in the diff; the box goes under the last.
      const [first, at] = selected?.startLine === undefined ? [null, selected]
        : orderRange(patch, selected.file, { line: selected.startLine, side: selected.startSide ?? selected.side }, selected).map((end) => ({ ...selected, ...end }));
      const summary = !!at && isSummary(at);
      const existing = !ask && at && !summary ? draft.comments.find((comment) => sameLocation(comment, at)) : undefined;
      // A comment keeps its own lines.
      const range = existing ? rangeOf(existing) : at && first ? rangeOf({ ...at, startLine: first.line, startSide: first.side }) : {};
      composerRevision.current = revisionRef.current;
      setEditing(existing ?? null);
      if (at) { setFile(at.file); setLine(String(at.line)); setSide(at.side); }
      // A new comment from the panel doesn't start where the summary's box was.
      else if (summaryBox) { setFile(firstFile); setLine("1"); setSide("RIGHT"); }
      setStartLine(range.startLine); setStartSide(range.startSide);
      setAsking(ask);
      setSummaryBox(summary);
      summaryBase.current = summary ? draft.body : null;
      setBody(summary && !ask ? draft.body : existing ? existing.body : "");
      setInline(inDiff);
      setShowComposer(true);
    }
    if (writing ? !inline : !inDiff) { setTab("draft"); setToolsOpen(true); }
    requestAnimationFrame(() => {
      const box = bodyRef.current;
      // Typing goes after the text being edited, not before it.
      box?.focus(); box?.setSelectionRange(box.value.length, box.value.length);
    });
  }
  useEffect(() => { if (prefill) openComposer(prefill, true, prefill.ask); }, [prefill]);
  function changeBody(text: string) {
    if (!body) composerRevision.current = revisionRef.current;
    setBody(text);
  }
  function closeComposer() {
    setEditing(null); setAsking(false); setStartLine(undefined); setStartSide(undefined);
    const kept = legacySummary.current;
    if (kept) {
      // The box is free for the summary text kept from before this update.
      legacySummary.current = null;
      updateDraftRecovery(targetKey, { summary: undefined });
      composerRevision.current = kept.revision;
      summaryBase.current = draft.body;
      setFile(SUMMARY_AT.file); setLine(String(SUMMARY_AT.line)); setSide(SUMMARY_AT.side); setInline(false); setSummaryBox(true); setBody(kept.body);
      setTab("draft"); setToolsOpen(true);
      return;
    }
    setBody(""); setShowComposer(false);
    // The next comment doesn't start where the summary's box was.
    if (summaryBox) { setFile(firstFile); setLine("1"); setSide("RIGHT"); }
    setSummaryBox(false);
  }
  /** Focus a comment's card where its box was: in the diff, or in this panel's list. */
  function focusComment(at: CommentLocation, inDiff: boolean, frames = 10) {
    requestAnimationFrame(() => {
      const key = locationKey(at);
      const card = inDiff
        ? Array.from(document.querySelectorAll<HTMLElement>("[data-draft-at]")).find((el) => el.dataset.draftAt === key)?.querySelector<HTMLElement>("article")
        : Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-comment-at]") ?? []).find((el) => el.dataset.commentAt === key);
      // The card may not have rendered yet.
      if (card) card.focus();
      else if (frames > 1) focusComment(at, inDiff, frames - 1);
    });
  }
  /** Close a line's box unsaved, and return focus to where it was opened, or else to the comment it edited. */
  function cancelComposer() {
    const at = { file, line: Number(line), side };
    closeComposer();
    const from = opener.current;
    if (from?.isConnected) requestAnimationFrame(() => from.focus());
    else focusComment(at, inline);
  }
  /** Close the summary's box, unsaved text and all, unless it holds a message to the agent. */
  function dropSummaryEdit() {
    if (onSummary && !asking) { closeComposer(); focusSummary(); }
  }

  /** Run a change to the draft; its error goes to `onError` when given, rather than a toast, and the status line shows what that returns, or the error. */
  async function mutate(operation: () => Promise<void>, onError?: (message: string) => string | void) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setStatus({ saving: true });
    try { await operation(); if (mounted.current) setStatus({}); }
    catch (error) {
      const message = error instanceof Error ? error.message : "Couldn’t save the draft. Try again.";
      const shown = onError?.(message);
      if (!onError) toast.error(message);
      if (mounted.current) setStatus({ error: shown || message });
    }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }

  /** The verdict is yours to pick; it saves at once. */
  function chooseVerdict(verdict: Verdict) {
    pendingVerdict.current = verdict;
    setDraft((previous) => ({ ...previous, verdict, verdictChosen: true }));
    setStatus({ saving: true });
    void enqueue(() => rpc.call("setVerdict", { targetKey, verdict, ...(revisionRef.current ? { revision: revisionRef.current } : {}) }))
      .then((result) => {
        if (pendingVerdict.current === verdict) pendingVerdict.current = null;
        const next = result.draft as Draft;
        if (mounted.current) { setDraft(pendingVerdict.current ? { ...next, verdict: pendingVerdict.current, verdictChosen: true } : next); setStatus({}); }
      })
      .catch((error) => {
        if (pendingVerdict.current === verdict) pendingVerdict.current = null;
        const message = error instanceof Error ? error.message : "Couldn’t save the verdict. Try again.";
        toast.error(message);
        if (mounted.current) setStatus({ error: message });
        refresh();
      });
  }
  /** Send the box's text to the agent, which answers in the line's discussion, or the summary's. */
  async function askAgent() {
    if (!body.trim()) return;
    await mutate(async () => {
      const result = await enqueue(() => rpc.call("askAgent", { targetKey, file, line: Number(line), side, ...(startLine ? { startLine } : {}), body: body.trim() }));
      apply(result as { draft: Draft }); closeComposer();
    });
  }
  /** A message to the agent from the summary, without the box: write it, or update it. */
  async function requestSummary(text: string) {
    await mutate(async () => {
      apply(await enqueue(() => rpc.call("askAgent", { targetKey, ...SUMMARY_AT, body: text })) as { draft: Draft });
      focusSummary();
    });
  }
  async function dismissDiscussion({ file, line, side }: CommentLocation) {
    await mutate(async () => {
      apply(await enqueue(() => rpc.call("dismissDiscussion", { targetKey, file, line, side })) as { draft: Draft });
    });
  }
  async function undo({ file, line, side }: CommentLocation) {
    await mutate(async () => {
      apply(await enqueue(() => rpc.call("undoAgentChange", { targetKey, file, line, side })) as { draft: Draft });
      if (isSummary({ file, line, side })) focusSummary();
    });
  }
  async function addComment() {
    if (!file.trim() || !body.trim() || !Number.isInteger(Number(line)) || Number(line) < 1) return;
    await mutate(async () => {
      const result = await enqueue(() => rpc.call("saveDraftComment", { targetKey, ...(composerRevision.current ? { revision: composerRevision.current } : {}), comment: { file, line: Number(line), side, ...rangeOf({ line: Number(line), side, startLine, startSide }), chapterId: editing?.chapterId ?? activeChapterId, body: body.trim() } }));
      apply(result as { draft: Draft }); closeComposer();
      focusComment({ file, line: Number(line), side }, inline);
    }, (message) => {
      if (!mounted.current) return;
      if (!rebuilding && composerRevision.current !== revisionRef.current) { setOlderDiff(true); return "Not saved: it was written against an older diff."; }
      setComposerError(message);
    });
  }
  /** Add a ```suggestion block holding the box's lines as they read now, for the reviewer to edit in place. */
  function suggestChange() {
    if (!suggestable) return;
    const next = `${body.trimEnd() ? `${body.trimEnd()}\n\n` : ""}\`\`\`suggestion\n${suggestable.join("\n")}\n\`\`\``;
    changeBody(next);
    requestAnimationFrame(() => {
      const box = bodyRef.current;
      // Typing goes at the end of the lines, before the closing fence.
      box?.focus(); box?.setSelectionRange(next.length - 4, next.length - 4);
    });
  }
  async function removeComment(comment: DraftComment) {
    const { file, line, side } = comment;
    // Putting back a comment on an older diff would bind it to the current one unchecked.
    const older = stale.some((at) => sameLocation(at, comment));
    await mutate(async () => {
      apply(await enqueue(() => rpc.call("removeDraftComment", { targetKey, file, line, side })) as { draft: Draft });
      if (older) toast.info("Comment removed");
      else toast.info("Comment removed", { action: { label: "Undo", onClick: () => { void latest.current.restoreComment(comment); } } });
    });
  }
  /** Put back a comment you removed, as it was, unless its line has another comment by now. */
  async function restoreComment(comment: DraftComment) {
    const { file, line, side, chapterId, author, body } = comment;
    if (shownComments.current.some((c) => sameLocation(c, { file, line, side }))) { toast.info(`${file}:${line} has another comment now, so the removed one stays removed.`); return; }
    await mutate(async () => {
      apply(await enqueue(() => rpc.call("saveDraftComment", { targetKey, ...(revisionRef.current ? { revision: revisionRef.current } : {}), comment: { file, line, side, ...rangeOf(comment), ...(chapterId ? { chapterId } : {}), ...(author ? { author } : {}), body } })) as { draft: Draft });
    });
  }
  /** Save the summary as yours; an empty one removes it. */
  async function saveSummary(text: string, revision = composerRevision.current) {
    await mutate(async () => {
      apply(await enqueue(() => rpc.call("saveSummary", { targetKey, body: text, ...(revision ? { revision } : {}) })) as { draft: Draft });
      if (text) closeComposer();
      focusSummary();
    });
  }
  /** Submit the draft; against the agent's suggestion or with the summary out of date, only once you confirm. */
  async function submit(confirmed = false) {
    if (isLocal || !loaded || body.trim()) return;
    if (doubts.length && !confirmed) { setConfirming(true); requestAnimationFrame(() => confirmCancelRef.current?.focus()); return; }
    setConfirming(false);
    await mutate(async () => {
      // What this page shows; the server refuses a draft that changed since.
      const { verdict, body: summary } = draft;
      const result = await enqueue(() => rpc.call("submitReview", { targetKey, ...(reviewRevision ? { revision: reviewRevision } : {}), ...(account ? { account } : {}), comments: shownComments.current, body: summary, verdict }));
      if (!result.ok) { refresh(); throw new Error(result.error ?? "Submit failed. Your draft is still here."); }
      setReceipt(verdict); setReceiptUrl(result.url ?? null);
      setWriteAnother(false);
      onSubmitted?.();
      toast.success("Review submitted to GitHub");
      await load();
    });
  }

  const canAdd = !busy && !rebuilding && !!file.trim() && !!body.trim() && Number.isInteger(Number(line)) && Number(line) >= 1;
  const positions = useMemo(() => diffPositions(patch), [patch]);
  // The new-file lines a comment's box is on, as they read now, for Suggest change; null on old-file lines.
  const suggestable = useMemo(() => {
    if (!showComposer || summaryBox || asking || side !== "RIGHT" || startSide) return null;
    const lines = positions.get(file)?.right;
    const texts: string[] = [];
    for (let n = startLine ?? Number(line); n <= Number(line); n++) {
      const text = lines?.get(n);
      if (text === undefined) return null;
      texts.push(text);
    }
    return texts.length ? texts : null;
  }, [positions, showComposer, summaryBox, asking, file, line, side, startLine, startSide]);
  const boxLines = linesOf({ line: Number(line), side, startLine, startSide });
  const hasReview = draft.comments.length > 0 || draft.body.trim().length > 0 || draft.verdict === "APPROVE";
  // GitHub refuses Request changes without a summary.
  const needsSummary = draft.verdict === "REQUEST_CHANGES" && !draft.body.trim();
  const submittedVerdict = review ? review.submittedVerdict : receipt;
  const closed = review?.prState === "MERGED" || review?.prState === "CLOSED";
  const completed = submittedVerdict && !hasReview && !writeAnother && !body.trim();
  // In the order the review reads: chapter by chapter, then file, line, and side.
  const sortedComments = useMemo(() => {
    const rank = (file: string) => { const index = files.indexOf(file); return index < 0 ? files.length : index; };
    return [...draft.comments].sort((a, b) => rank(a.file) - rank(b.file) || a.file.localeCompare(b.file) || a.line - b.line || (a.side === b.side ? 0 : a.side === "LEFT" ? -1 : 1));
  }, [draft.comments, files]);
  // Submitting refuses comments drafted against an older diff.
  const staleComments = sortedComments.filter((comment) => stale.some((at) => sameLocation(at, comment)));
  const summaryDiscussion = discussions.find(isSummary);
  const lineDiscussions = useMemo(() => discussions.filter((d) => !isSummary(d)), [discussions]);
  // The Submit review button in the review's top bar follows this draft.
  const submittable = loaded && !loadError && !closed && !isLocal && !completed;
  useEffect(() => {
    setDraftStatus(targetKey, submittable ? { verdict: draft.verdict, comments: draft.comments.length } : null);
  }, [targetKey, submittable, draft.verdict, draft.comments.length]);
  useEffect(() => () => setDraftStatus(targetKey, null), [targetKey]);
  // The diff shows the draft's comments and discussions, and the comment box while it's open there.
  const latest = useRef({ openComposer, removeComment, addComment, askAgent, dismissDiscussion, undo, changeBody, closeComposer, dropSummaryEdit, keepOnCurrentDiff, restoreComment, cancelComposer, suggestChange });
  latest.current = { openComposer, removeComment, addComment, askAgent, dismissDiscussion, undo, changeBody, closeComposer, dropSummaryEdit, keepOnCurrentDiff, restoreComment, cancelComposer, suggestChange };
  const open = useCallback((at: CommentLocation) => latest.current.openComposer(at, true), []);
  const ask = useCallback((at: CommentLocation) => latest.current.openComposer(at, true, true), []);
  const remove = useCallback((comment: DraftComment) => { void latest.current.removeComment(comment); }, []);
  const dismiss = useCallback((at: CommentLocation) => { void latest.current.dismissDiscussion(at); }, []);
  const undoAt = useCallback((at: CommentLocation) => { void latest.current.undo(at); }, []);
  const showChat = useCallback(() => { setTab("agent"); setToolsOpen(true); }, []);
  const editable = loaded && !loadError && !closed;
  // On your own PR, Comment is the only verdict GitHub takes.
  useEffect(() => { if (ownPr && editable && !isLocal && draft.verdict !== "COMMENT" && !pendingVerdict.current) chooseVerdict("COMMENT"); }, [ownPr, editable, isLocal, draft.verdict]);
  const ownPrId = useId();
  const writing = !!body.trim();
  const composerInDiff = editable && showComposer && inline;
  const chat = agent ? showChat : null;
  const editingLine = showComposer && !summaryBox && !asking;
  const inlineDraft = useMemo<InlineDraft>(() => ({
    comments: draft.comments, stale, discussions: lineDiscussions, editable, busy, writing, open, ask, remove, dismiss, undo: undoAt, chat,
    composer: composerInDiff ? { file, line: Number(line), side, ...(startLine ? { startLine } : {}), editing: editing !== null, asking } : null,
    editingAt: editingLine ? { file, line: Number(line), side } : null,
  }), [draft.comments, stale, lineDiscussions, editable, busy, writing, open, ask, remove, dismiss, undoAt, chat, composerInDiff, editingLine, file, line, side, startLine, editing, asking]);
  const canSuggest = !!suggestable;
  const inlineComposer = useMemo<InlineComposer | null>(() => composerInDiff ? {
    body, textareaRef: bodyRef, error: composerError, rebuilding, keepOnCurrentDiff: olderDiff ? () => latest.current.keepOnCurrentDiff() : null,
    change: (text) => latest.current.changeBody(text),
    save: () => { void latest.current.addComment(); },
    askAgent: () => { void latest.current.askAgent(); },
    cancel: () => latest.current.cancelComposer(),
    suggest: canSuggest ? () => latest.current.suggestChange() : null,
  } : null, [composerInDiff, body, composerError, rebuilding, olderDiff, canSuggest]);
  const summaryComposer = editable && onSummary ? {
    mode: asking ? "ask" as const : "edit" as const, body, textareaRef: bodyRef,
    change: changeBody, save: () => { void saveSummary(body.trim()); }, askAgent: () => { void askAgent(); }, cancel: () => { closeComposer(); focusSummary(); },
  } : null;
  const toolItems = [
    { id: "draft", label: "Draft review", icon: "MessageSquare", count: draft.comments.length },
    { id: "notes", label: "Reviewer notes", icon: "EditFile", count: 0 },
    ...(agent ? [{ id: "agent", label: "Ask agent", icon: "BubbleChatSpark", count: 0 }] as const : []),
  ] as const;
  const hint = isLocal ? "Local review. Comments and notes stay in this BB installation."
    : writing ? asking ? "Send or cancel your message to the agent before submitting." : onSummary ? "Save or cancel the summary before submitting." : "Add the comment you’re writing to the draft before submitting."
    : rebuilding ? "The guide is rebuilding for new commits. Submit when it’s ready."
    : staleComments.length ? `The diff changed after these comments were drafted. Edit and save, or remove: ${staleComments.map((c) => `${c.file}:${c.line}`).join(", ")}`
    : needsSummary ? "Requesting changes needs a summary: say what has to change."
    : "Drafts stay in BB until you submit.";
  const suggested = draft.suggestedVerdict;
  const changes = summaryChanges(draft);
  // Why Submit asks once more: the agent suggested another verdict, or its summary no longer fits.
  const doubts = [
    ...(suggested && suggested !== draft.verdict && !ownPr ? [`The agent suggested ${VERDICT_LABEL[suggested]}.`] : []),
    ...(changes.comments && changes.verdict ? [`Your comments changed, and the summary was written for ${VERDICT_LABEL[changes.verdict]}.`]
      : changes.comments ? ["Your comments changed since the agent wrote the summary."]
      : changes.verdict ? [`The summary was written for ${VERDICT_LABEL[changes.verdict]}.`] : []),
  ];
  const commentCount = draft.comments.length;
  return <InlineDraftContext.Provider value={inlineDraft}><InlineComposerContext.Provider value={inlineComposer}>
  {children}
  <aside aria-label="Review tools" className={cn("flex max-h-[50vh] min-h-0 shrink-0 flex-col border-t border-border bg-background @min-[1024px]/review:h-full @min-[1024px]/review:max-h-none @min-[1024px]/review:flex-row-reverse @min-[1024px]/review:border-l @min-[1024px]/review:border-t-0", toolsOpen ? "@min-[1024px]/review:w-[384px]" : "@min-[1024px]/review:w-11", toolsOpen && tab === "agent" && "h-[50vh]")}>
    <div ref={railRef} role="group" aria-label="Review tools" className={cn("flex h-11 shrink-0 items-center gap-0.5 bg-surface-raised p-0.5 @min-[1024px]/review:h-full @min-[1024px]/review:w-11 @min-[1024px]/review:flex-col @min-[1024px]/review:gap-1 @min-[1024px]/review:pt-1.5", toolsOpen && "border-b border-border @min-[1024px]/review:border-b-0 @min-[1024px]/review:border-l")}>
      <Tooltip.Provider delayDuration={350}>
        {toolItems.map((tool) => <Tooltip.Root key={tool.id}>
          <Tooltip.Trigger asChild>
            <Button variant="ghost" size="icon" data-tool={tool.id} aria-label={tool.label} aria-pressed={toolsOpen && tab === tool.id} aria-expanded={toolsOpen && tab === tool.id} aria-controls={panelId} onClick={() => selectTool(tool.id)} className={cn("relative size-10 shrink-0 rounded-lg text-muted-foreground aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:bg-primary/15 [&_svg]:size-[18px]", tool.id === "agent" && "aria-pressed:bg-(--ansi-13)/10 aria-pressed:text-(--ansi-13) aria-pressed:hover:bg-(--ansi-13)/15", toolsOpen && tab === tool.id && "after:absolute after:inset-x-2.5 after:-bottom-0.5 after:h-0.5 after:rounded-full after:bg-current @min-[1024px]/review:after:inset-y-2.5 @min-[1024px]/review:after:-right-0.5 @min-[1024px]/review:after:left-auto @min-[1024px]/review:after:h-auto @min-[1024px]/review:after:w-0.5")}>
              <Icon name={tool.icon} aria-hidden />
              {tool.count > 0 && <span aria-hidden className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-primary-foreground ring-2 ring-background">{tool.count > 99 ? "99+" : tool.count}</span>}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Portal container={agent?.container ?? undefined}><Tooltip.Content {...scopeProps} side="left" sideOffset={8} collisionPadding={8} className="z-[75] rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">{tool.label}{tool.count > 0 ? ` (${tool.count})` : ""}</Tooltip.Content></Tooltip.Portal>
        </Tooltip.Root>)}
      </Tooltip.Provider>
      <span className="ml-auto min-w-0 truncate px-2 text-xs text-muted-foreground @min-[1024px]/review:hidden">{toolsOpen ? toolItems.find((tool) => tool.id === tab)?.label : "Review tools"}</span>
      {toolsOpen && <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground @min-[1024px]/review:hidden" aria-label="Collapse review panel" onClick={collapse}><Icon name="X" aria-hidden /></Button>}
    </div>
    <div id={panelId} hidden={!toolsOpen} className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !toolsOpen && "hidden")}>
      {tab !== "agent" && <div className="hidden h-11 shrink-0 items-center gap-2 border-b border-border px-3 @min-[1024px]/review:flex"><Icon name={tab === "draft" ? "MessageSquare" : "EditFile"} className="size-4 text-primary" aria-hidden /><h2 className="min-w-0 truncate text-sm font-medium">{tab === "draft" ? "Draft review" : "Reviewer notes"}</h2><span className="flex-1" /><Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Collapse review panel" onClick={collapse}><Icon name="X" aria-hidden /></Button></div>}
    {agent && <AgentDock targetKey={targetKey} {...agent} active={toolsOpen && tab === "agent"} onDock={() => { setTab("agent"); setToolsOpen(true); }} onCollapse={collapse} />}
    <div hidden={tab !== "notes"} className={cn("min-h-0 overflow-y-auto", tab !== "notes" && "hidden")}><ReviewerNotes targetKey={targetKey} /></div>
    <div hidden={tab !== "draft"} className={cn("flex min-h-0 flex-1 flex-col", tab !== "draft" && "hidden")}>
      {loadError ? <div role="alert" className="space-y-3 overflow-y-auto p-3 text-sm"><p>Couldn’t load your draft. Editing is paused to protect it.</p><Button variant="outline" onClick={() => void load()}>Retry draft</Button></div> : !loaded ? <p role="status" className="p-3 text-sm text-muted-foreground">Loading draft…</p> : closed ?
        <div className="min-h-0 overflow-y-auto"><section aria-label="Archived review" className="m-3 space-y-2 rounded-lg border border-border bg-muted/25 p-3">
          <p className="flex items-center gap-2 text-sm font-medium"><Icon name={review?.prState === "MERGED" ? "GitMerge" : "GitPullRequestClosed"} className={cn("size-4", review?.prState === "MERGED" ? "text-pr-merged" : "text-destructive-text")} aria-hidden />{review?.prState === "MERGED" ? "Merged" : "Closed"} · Archived</p>
          <p className="text-xs leading-relaxed text-muted-foreground">This review is saved in Archive. The guide, notes, and conversation remain available.</p>
          {(draft.comments.length > 0 || draft.body) && <details className="text-sm"><summary className="cursor-pointer">Unsubmitted draft</summary><p className="mt-2 whitespace-pre-wrap">{draft.body}</p>{draft.comments.map((comment, index) => <p key={index} className="mt-2 break-words">{comment.file}:{comment.line} — {comment.body}</p>)}</details>}
        </section></div> : completed ?
        <section aria-label="Submitted review" className="m-3 space-y-3 rounded-lg border border-success/25 bg-success/10 p-3">
          <p className="flex items-center gap-2 text-sm font-medium text-diff-added"><Icon name="BadgeCheck" className="size-5" aria-hidden />{RECEIPT_LABEL[submittedVerdict]}</p>
          <p className="text-xs text-muted-foreground">Review submitted to GitHub</p>
          <div className="flex flex-wrap gap-2">
            {(receiptUrl ?? review?.url) && <UrlLink href={(receiptUrl ?? review?.url)!} className={buttonVariants({ variant: "outline", size: "sm" })}><Icon name="Github" className="size-4" aria-hidden />View on GitHub</UrlLink>}
            <Button variant="outline" size="sm" onClick={() => setWriteAnother(true)}>Add another review</Button>
          </div>
        </section> : <section aria-label="Review draft" className="flex min-h-0 flex-1 flex-col [@media(max-height:560px)]:overflow-y-auto">
          {/* On short screens the draft and its foot scroll together, so the foot doesn't crowd out the draft. */}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 [@media(max-height:560px)]:flex-none [@media(max-height:560px)]:overflow-visible">
            <span role="status" className={cn("flex items-center gap-1.5 text-xs", status.error ? "text-destructive-text" : "text-muted-foreground")}>{status.error ? <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden /> : status.saving ? <Icon name="Loading" className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden /> : <Icon name="CircleCheck" className="size-3.5 text-diff-added" aria-hidden />}{status.error ?? (status.saving ? "Saving…" : "Draft saved")}</span>
            <SummaryCard cardRef={summaryRef} draft={draft} discussion={summaryDiscussion} editable={editable} busy={busy} writing={writing && !onSummary} composer={summaryComposer} isLocal={isLocal} chat={chat}
              changedWhileEditing={onSummary && !asking && summaryBase.current !== null && summaryBase.current !== draft.body}
              onEdit={() => openComposer(SUMMARY_AT, false)} onAsk={() => openComposer(SUMMARY_AT, false, true)} onRemove={() => void saveSummary("", revisionRef.current)}
              onUndo={() => void undo(SUMMARY_AT)} onRequest={(text) => void requestSummary(text)} />
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">Line comments</h3>
              {draft.comments.length > 0 && <span className="rounded-full bg-muted px-1.5 text-[11px] leading-[18px] tabular-nums text-muted-foreground">{draft.comments.length}</span>}
              <span className="flex-1" />
              <Button variant="ghost" size="sm" className="-mr-2 text-primary hover:text-primary" aria-expanded={showComposer && !inline && !onSummary} onClick={() => openComposer(null, false)}><Icon name="Plus" className="size-4" aria-hidden /> Add comment</Button>
            </div>
            {draft.comments.length ? <ul ref={listRef} className="space-y-2 text-sm">{sortedComments.map((comment) => {
              const isStale = stale.some((at) => sameLocation(at, comment));
              const discussion = discussions.find((d) => sameLocation(d, comment));
              const messages = discussion?.entries.filter((entry) => entry.kind === "message").length ?? 0;
              return <li key={`${comment.file}:${comment.line}:${comment.side}`} tabIndex={-1} data-comment-at={locationKey(comment)} className={cn("group/comment space-y-2 rounded-lg border border-border bg-card p-3 outline-none transition-colors hover:border-input focus-visible:ring-2 focus-visible:ring-ring/50", comment.author === "agent" ? "border-l-[3px] border-l-(--ansi-13)/60" : "border-l-[3px] border-l-primary/60")}>
              <button type="button" aria-label={`${comment.file}:${linesOf(comment)}${comment.side === "LEFT" ? " · Old line" : ""}${comment.author === "agent" ? " · Added by agent" : ""}${isStale ? " · Older diff" : ""}${discussionLabel(discussion)}`} className="flex w-full min-w-0 flex-wrap items-center gap-1.5 rounded-sm text-left text-xs hover:[&_.gr-path]:underline" onClick={() => onShowComment?.(comment)}>
                <span className="gr-path flex min-w-0 max-w-full items-center decoration-muted-foreground/50 underline-offset-2"><FilePath path={comment.file} className="min-w-0 text-[11px]" /><span className="shrink-0 font-mono text-[11px] text-primary">:{linesOf(comment)}</span></span>
                {comment.side === "LEFT" && <Badge size="sm">Old line</Badge>}
                {comment.author === "agent" && <Badge tone="agent" size="sm" icon={<Icon name="Sparkles" aria-hidden />}>Agent</Badge>}
                {isStale && <Badge tone="warning" size="sm">Older diff</Badge>}
                {discussion?.waiting ? <Badge tone="agent" dot pulse size="sm">Waiting for agent</Badge> : messages > 0 && <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Icon name="MessageSquare" className="size-3" aria-hidden />{messages}</span>}
              </button>
              <CommentBody body={comment.body} />
              <div className="-mb-1 -ml-2 flex gap-0.5"><Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" disabled={busy || !!body.trim()} aria-label={`Edit comment on ${comment.file}:${linesOf(comment)}`} onClick={() => openComposer(comment, false)}><Icon name="Edit" className="size-3.5" aria-hidden />Edit</Button><Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive-text" disabled={busy} aria-label={`Remove comment on ${comment.file}:${linesOf(comment)}`} onClick={() => void removeComment(comment)}><Icon name="Trash2" className="size-3.5" aria-hidden />Remove</Button></div>
            </li>; })}</ul> : !(showComposer && !onSummary) && <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-6 text-center"><Icon name="MessageSquarePlus" className="size-5 text-subtle-foreground" aria-hidden /><p className="text-sm leading-relaxed text-muted-foreground">Select a line in the diff or add a comment here.</p></div>}
            {showComposer && !onSummary && (inline ? <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 break-words">{asking ? `Writing to the agent about ${file}:${boxLines} in the diff.` : `Writing a comment on ${file}:${boxLines} in the diff.`}</span>
              <Button variant="ghost" size="sm" onClick={() => onShowComment?.({ file, line: Number(line), side })}>Show in diff</Button>
            </div> : <div className="space-y-3 border-t border-border pt-3">
              <label className="block space-y-1 text-xs text-muted-foreground">File<select aria-label="Comment file" disabled={busy || !!editing} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground" value={file} onChange={(event) => setFile(event.target.value)}>{(file && !files.includes(file) ? [file, ...files] : files).map((choice) => <option key={choice} value={choice}>{choice}</option>)}</select></label>
              <div className="grid grid-cols-[80px_minmax(0,1fr)] gap-3">
                {startLine ? <p className="space-y-1 text-xs text-muted-foreground">Lines<span className="flex h-9 items-center text-sm text-foreground tabular-nums">{boxLines}</span></p>
                  : <label className="space-y-1 text-xs text-muted-foreground">Line<Input aria-label="Comment line" disabled={busy || !!editing} type="number" min={1} value={line} onChange={(event) => setLine(event.target.value)} /></label>}
                <label className="space-y-1 text-xs text-muted-foreground">Side<select aria-label="Comment side" disabled={busy || !!editing} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground" value={side} onChange={(event) => setSide(event.target.value as "LEFT" | "RIGHT")}><option value="RIGHT">New line</option><option value="LEFT">Old line</option></select></label>
              </div>
              <Textarea ref={bodyRef} aria-label="Draft comment" disabled={busy} value={body} onChange={(event) => changeBody(event.target.value)} onKeyDown={(event) => composerKeys(event, canAdd ? () => void addComment() : null, () => { if (!busy) cancelComposer(); })} placeholder="What should the author know?" />
              <ComposerNotes error={composerError} rebuilding={rebuilding} keepOnCurrentDiff={olderDiff ? keepOnCurrentDiff : null} />
              <div className="flex flex-wrap gap-2"><Button disabled={!canAdd} onClick={() => void addComment()}>{editing ? "Save comment" : "Add to draft"}</Button><Button variant="ghost" disabled={busy} onClick={cancelComposer}>Cancel</Button>{suggestable && <Button variant="outline" className="ml-auto" disabled={busy} onClick={suggestChange}><Icon name="Edit" className="size-3.5" aria-hidden />Suggest change</Button>}</div>
            </div>)}
            {(isLocal || ownPr) && <FixHandoff targetKey={targetKey} comments={sortedComments} />}
          </div>
          <footer className="shrink-0 space-y-2.5 border-t border-border p-3">
            {!isLocal && <>
              <div role="group" aria-label="Review verdict" className="flex max-w-full flex-wrap gap-0.5 rounded-lg bg-muted/40 p-1 ring-1 ring-inset ring-border">
                {VERDICTS.map(([verdict, pressed]) => <Button key={verdict} type="button" variant="ghost" size="sm" disabled={busy || ownPr && verdict !== "COMMENT"} {...(ownPr && verdict !== "COMMENT" ? { title: OWN_PR, "aria-describedby": ownPrId } : {})} aria-pressed={draft.verdict === verdict} aria-label={suggested === verdict ? `${VERDICT_LABEL[verdict]}, suggested by the agent` : undefined} className={cn("relative h-8 grow basis-auto whitespace-nowrap px-2 text-xs text-muted-foreground ring-1 ring-inset ring-transparent aria-pressed:shadow-xs", suggested === verdict && "pr-3.5", pressed)} onClick={() => chooseVerdict(verdict)}>
                  {VERDICT_LABEL[verdict]}{suggested === verdict && <span aria-hidden title="Suggested by the agent" className="absolute right-0.5 top-0.5 flex"><Icon name="Sparkles" className="size-2.5 text-(--ansi-13)" /></span>}
                </Button>)}
              </div>
              {ownPr && <p id={ownPrId} className="text-xs text-muted-foreground">{OWN_PR}</p>}
              {suggested && (suggested !== draft.verdict || !verdictPicked(draft)) && !(ownPr && suggested !== "COMMENT") && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon name="Sparkles" className="size-3.5 shrink-0 text-(--ansi-13)" aria-hidden />Agent suggests {VERDICT_LABEL[suggested]}</p>}
              {confirming ? <div role="alert" className="space-y-2 rounded-lg border border-warning/25 bg-warning/10 p-2.5 text-xs leading-relaxed text-warning-text">
                <p>Submit {VERDICT_LABEL[draft.verdict]}{commentCount ? ` with ${commentCount} comment${commentCount === 1 ? "" : "s"}` : ""}? {doubts.join(" ")}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy || rebuilding || !hasReview || writing || needsSummary || staleComments.length > 0} onClick={() => void submit(true)}>Submit anyway</Button>
                  <Button ref={confirmCancelRef} size="sm" variant="ghost" onClick={() => { setConfirming(false); requestAnimationFrame(() => submitRef.current?.focus()); }}>Cancel</Button>
                </div>
              </div>
              : <Button ref={submitRef} className="w-full gap-2" disabled={busy || rebuilding || !hasReview || writing || needsSummary || staleComments.length > 0} onClick={() => void submit()}>{busy ? <Icon name="Loading" className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <Icon name="Github" className="size-4" aria-hidden />}{busy ? "Saving…" : "Submit to GitHub"}</Button>}
            </>}
            <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
          </footer>
        </section>}
    </div>
    </div>
  </aside>
  </InlineComposerContext.Provider></InlineDraftContext.Provider>;
});
DraftTray.displayName = "DraftTray";

/** How a comment's discussion with the agent reads in the panel. */
function discussionLabel(discussion: Discussion | undefined): string {
  if (!discussion) return "";
  const messages = discussion.entries.filter((entry) => entry.kind === "message").length;
  return `${messages ? ` · ${messages} message${messages === 1 ? "" : "s"}` : ""}${discussion.waiting ? " · Waiting for agent" : ""}`;
}
