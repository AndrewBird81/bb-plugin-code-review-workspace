import type { SubmitWarning } from "../src/submit-review";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { ReviewItem } from "../lib/review-state";
import { commentsKey, isPreExisting, isSummary, linesOf, rangeOf, sameLocation, SEVERITIES, severityCounts, SEVERITY_LABEL, summaryChanges, SUMMARY_AT, VERDICT_LABEL, type CommentLocation, type Discussion, type Draft, type DraftComment, type Severity, type Verdict } from "../src/draft";
import { diffPositions, orderRange, type FilePositions } from "../src/review-positions";
import { splitPatchByFile } from "../src/patch";
import { carries, insertLines } from "../src/post-preview";
import { getHideNits, setHideNits, type PanelView } from "../lib/panel-state";
import { approveDoubts, type ApproveGuard } from "../lib/approve-guard";
import { readOf, type AgentCoverage } from "../lib/agent-coverage";
import { readDraftRecovery, updateDraftRecovery } from "../lib/draft-recovery";
import { setDraftStatus } from "../lib/draft-status";
import { holdReview } from "../lib/review-holds";
import { useKnob } from "../lib/settings";
import { useWorkspace } from "../lib/workspace-context";
import { RemovalWhy, type WhyRequest } from "./comments/RemovalWhy";
import { InlineComposerContext, InlineDraftContext, locationKey, type CommentStart, type InlineComposer, type InlineDraft } from "./InlineDraft";

/**
 * A request from the diff to comment on a line, or with `ask` to message the agent about it; the box
 * opens there. `startLine` and `startSide` are the other end of a selection, in either order.
 */
export interface CommentPrefill { file: string; line: number; side: "LEFT" | "RIGHT"; startLine?: number; startSide?: "LEFT" | "RIGHT"; ask?: boolean; nonce: number; }

export interface DraftProviderProps {
  targetKey: string; activeChapterId: string; activeFiles: string[];
  /** The review's diff, to order a selection's lines and fill in a suggested change. */
  patch?: string;
  /** The review's changed files, chapter by chapter. */
  files?: string[];
  prefill?: CommentPrefill; isLocal?: boolean; review?: ReviewItem; onSubmitted?: () => void;
  reviewRevision?: string; account?: string;
  /** The guide is rebuilding for new commits: comments and submit wait for the new diff. */
  rebuilding?: boolean;
  /** The signed-in account wrote the PR, so GitHub allows only a Comment review. */
  ownPr?: boolean;
  /** What an approval leaves unread or read too fast (lib/approve-guard.ts); without it, approving asks nothing more. */
  approveGuard?: ApproveGuard;
  /** What the agent read through Code Review Workspace (lib/agent-coverage.ts); without it, Finish review doesn't say. */
  agentCoverage?: AgentCoverage;
  /** A new value focuses the summary, which Finish review shows. `replaced`: you agreed the assistant's suggestion replaces your summary. */
  showDraft?: { at: number; replaced?: boolean };
  /** Show the side panel's view of the draft: its comments, its summary and Submit (`finish`), or the agent's chat. */
  onOpenPanel?: (view: PanelView) => void;
  /** The workspace, whose diff shows the draft's comments under their lines and whose panel shows the draft. */
  children?: ReactNode;
}

export type DraftState = ReturnType<typeof useDraftState>;
const DraftContext = createContext<DraftState | null>(null);

/** The draft and everything that changes it, for Comments, Finish review and the cards in the code. */
export function useDraft(): DraftState {
  const draft = useContext(DraftContext);
  if (!draft) throw new Error("useDraft() needs a DraftProvider around it.");
  return draft;
}

/**
 * Owns the review's draft: loading and saving it, the comment box and its recovery, and Submit and its lock. The diff
 * shows the draft through InlineDraftContext and InlineComposerContext; the side panel through useDraft.
 */
export const DraftProvider = memo(function DraftProvider({ children, ...props }: DraftProviderProps) {
  const state = useDraftState(props);
  return <DraftContext.Provider value={state}><InlineDraftContext.Provider value={state.inlineDraft}><InlineComposerContext.Provider value={state.inlineComposer}>
    {children}
    {state.why && <RemovalWhy key={`${state.why.at.file}:${state.why.at.line}:${state.why.at.side}`} request={state.why} onClose={() => state.setWhy(null)} />}
  </InlineComposerContext.Provider></InlineDraftContext.Provider></DraftContext.Provider>;
});
DraftProvider.displayName = "DraftProvider";

function useDraftState({ targetKey, activeChapterId, activeFiles, files = activeFiles, prefill, isLocal = false, review, onSubmitted, onOpenPanel, reviewRevision, rebuilding = false, ownPr = false, approveGuard, agentCoverage, account, showDraft, patch = "" }: Omit<DraftProviderProps, "children">) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState<Draft>({ targetKey, verdict: "COMMENT", body: "", comments: [] });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  // Submit is posting to GitHub, rather than a change being saved.
  const [submitting, setSubmitting] = useState(false);
  // The status line: the draft is saved, being saved, or why the last save or submit failed.
  const [status, setStatus] = useState<{ saving?: true; error?: string }>({});
  // A chapter with no files starts the form on the review's first file.
  const firstFile = activeFiles[0] ?? files[0] ?? "";
  const [file, setFile] = useState(firstFile);
  const [line, setLine] = useState("1");
  const [side, setSide] = useState<"LEFT" | "RIGHT">("RIGHT");
  const [body, setBody] = useState("");
  // The box's text as it opened: the comment or summary it edits, or nothing. Text other than that is yours, unsaved.
  const openedBody = useRef("");
  // What the plugin put in the box, as it opened or by Suggest change; null when that isn't known, as for a box restored
  // from before it was kept. A message to the agent still carrying any of it confirms no post (src/asking.ts).
  const filled = useRef<string[] | null>([]);
  // The severity the box's comment gets; a label its text starts with sets it instead.
  const [severity, setSeverity] = useState<Severity | undefined>();
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
  const [hideNits, setHideNitsState] = useState(getHideNits);
  function toggleNits() { setHideNits(!hideNits); setHideNitsState(!hideNits); }
  const [receipt, setReceipt] = useState<Verdict | null>(null);
  // Submit asked whether you're sure; any change to the draft asks again.
  const [confirming, setConfirming] = useState(false);
  // What the server held Submit back for, and what it offers: Submit anyway, Submit as Comment, Open it on GitHub. Any
  // change to the draft clears it, as Submit checks again.
  const [warned, setWarned] = useState<{ text: string; offers: Array<"anyway" | "comment" | "github">; warnings: SubmitWarning[]; newCommits?: { count: number | null; url: string } } | null>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const draftKey = `${draft.verdict}\0${draft.body}\0${commentsKey(draft.comments)}`;
  useEffect(() => { setConfirming(false); setWarned(null); }, [draftKey]);
  // The review this panel posted, on GitHub.
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // What had focus when the box opened, for focus to return to when it's cancelled.
  const opener = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLElement>(null);
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
  // Why? on Comment removed, for an agent's comment, while Settings asks why.
  const askWhy = useKnob("removalReasons");
  const [why, setWhy] = useState<WhyRequest | null>(null);
  const focusSummary = () => requestAnimationFrame(() => summaryRef.current?.focus());

  useEffect(() => {
    if (!loaded) return;
    updateDraftRecovery(targetKey, { composer: body ? { file, line, side, body, revision: composerRevision.current, inline, ...(filled.current ? { filled: filled.current } : {}), ...(asking ? { asking } : {}), ...(startLine ? { startLine } : {}), ...(startSide ? { startSide } : {}), ...(summaryBox ? { summary: true } : {}), ...(severity ? { severity } : {}), ...(editing && !asking && !summaryBox ? { editing: editing.body } : {}) } : undefined });
  }, [loaded, targetKey, file, line, side, body, inline, asking, startLine, startSide, summaryBox, severity, editing]);
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
        setSeverity(SEVERITIES.find((choice) => choice === comment.severity));
        summaryBase.current = comment.summary ? (result.draft as Draft).body : null;
        // An edit stays one only while its comment reads as it did; otherwise a comment at the line is one to replace.
        const atLine = comment.asking || comment.summary ? null : (result.draft as Draft).comments.find((c) => sameLocation(c, { file: comment.file, line: Number(comment.line), side: comment.side }));
        const edited = atLine && comment.editing === atLine.body ? atLine : null;
        setEditing(edited);
        openedBody.current = comment.asking ? "" : summaryBase.current ?? edited?.body ?? "";
        filled.current = comment.filled ?? null;
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
    // You agreed the suggestion replaces the summary you were writing.
    if (showDraft.replaced) latest.current.dropSummaryEdit();
    // Focusing the summary scrolls it into view.
    focusSummary();
    refresh();
  }, [showDraft, refresh]);

  useEffect(() => { if (!showComposer && !body.trim()) setFile(firstFile); }, [firstFile, showComposer, body]);
  /**
   * Open the comment box, in the diff or this panel, on a line's comment if it has one, or on the
   * summary (SUMMARY_AT); with `ask`, a box for a message to the agent; a new comment starts with `start`. An unfinished
   * comment or message is shown instead.
   */
  function openComposer(selected: (CommentLocation & Pick<CommentPrefill, "startLine" | "startSide">) | null, inDiff: boolean, ask = false, start?: CommentStart) {
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
      const fresh = !summary && !existing ? start : undefined;
      openedBody.current = summary && !ask ? draft.body : existing ? existing.body : fresh?.body ?? "";
      filled.current = openedBody.current ? [openedBody.current] : [];
      setBody(openedBody.current);
      setSeverity(existing?.severity ?? fresh?.severity);
      setInline(inDiff);
      setShowComposer(true);
    }
    // A box in the panel shows there: the summary's in Finish review, a line's in Comments.
    if (writing ? !inline : !inDiff) onOpenPanel?.((writing ? onSummary : !!selected && isSummary(selected)) ? "finish" : "comments");
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
    setEditing(null); setAsking(false); setStartLine(undefined); setStartSide(undefined); setSeverity(undefined);
    const kept = legacySummary.current;
    if (kept) {
      // The box is free for the summary text kept from before this update.
      legacySummary.current = null;
      updateDraftRecovery(targetKey, { summary: undefined });
      composerRevision.current = kept.revision;
      summaryBase.current = draft.body;
      openedBody.current = draft.body;
      filled.current = null;
      setFile(SUMMARY_AT.file); setLine(String(SUMMARY_AT.line)); setSide(SUMMARY_AT.side); setInline(false); setSummaryBox(true); setBody(kept.body);
      onOpenPanel?.("finish");
      return;
    }
    openedBody.current = "";
    filled.current = [];
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
  /**
   * Before a comment is removed: where the focus goes once its card, which has it, is gone. In the code, to the next
   * comment's card in its file, else the file's row; in the list, to the next row, else the one before, else the filter.
   */
  function focusAfterRemoval(): () => void {
    const held = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const card = held?.closest<HTMLElement>("[data-draft-at]");
    const row = card ? null : held?.closest<HTMLElement>("[data-comment-row]");
    let targets: Array<() => HTMLElement | null | undefined> = [];
    if (card) {
      const path = card.closest<HTMLElement>("[data-file]")?.dataset.file;
      const fileEl = () => Array.from(document.querySelectorAll<HTMLElement>("[data-file]")).find((el) => el.dataset.file === path);
      const cards = Array.from(fileEl()?.querySelectorAll<HTMLElement>("[data-draft-at]") ?? []);
      const after = cards.slice(cards.indexOf(card) + 1).map((el) => el.dataset.draftAt);
      targets = [
        ...after.map((key) => () => Array.from(fileEl()?.querySelectorAll<HTMLElement>("[data-draft-at]") ?? []).find((el) => el.dataset.draftAt === key)?.querySelector<HTMLElement>("article[tabindex], button")),
        () => fileEl()?.querySelector<HTMLElement>("[data-file-header] button"),
      ];
    } else if (row) {
      const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-comment-row]") ?? []);
      const index = rows.indexOf(row);
      const rowButton = (id: string | undefined) => () => Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-comment-row]") ?? []).find((el) => el.dataset.commentRow === id)?.querySelector("button");
      targets = [
        ...rows.slice(index + 1).map((el) => rowButton(el.dataset.commentRow)),
        ...rows.slice(0, index).reverse().map((el) => rowButton(el.dataset.commentRow)),
        () => listRef.current?.querySelector<HTMLElement>("[role=radio][aria-checked=true]"),
      ];
    }
    return () => requestAnimationFrame(() => {
      // Only when the focus went with the card, or stayed on its button, which may now draw another comment.
      if (document.activeElement && document.activeElement !== document.body && document.activeElement !== held) return;
      for (const target of targets) {
        const el = target();
        if (el) return void el.focus({ preventScroll: true });
      }
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

  // Saving disables the box, which drops its focus; a refused save puts it back, with the reason and buttons in view.
  const refocusBox = useRef(false);
  useEffect(() => {
    if (busy || !refocusBox.current) return;
    refocusBox.current = false;
    const box = bodyRef.current;
    box?.focus({ preventScroll: true });
    box?.parentElement?.scrollIntoView?.({ block: "nearest" });
  }, [busy]);
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
  /**
   * Send the box's text to the agent, which answers in the line's discussion, or the summary's. Still carrying text the
   * plugin put in the box, such as a check's failure quoted or a suggestion's lines, or not known not to, it confirms no
   * post (src/asking.ts).
   */
  async function askAgent() {
    if (!body.trim()) return;
    const inserted = !filled.current || filled.current.some((text) => carries(body, insertLines(text)));
    await mutate(async () => {
      const result = await enqueue(() => rpc.call("askAgent", { targetKey, file, line: Number(line), side, ...(startLine ? { startLine } : {}), body: body.trim(), inserted }));
      apply(result as { draft: Draft }); closeComposer();
    });
  }
  /** A message to the agent from the summary, without the box: write it, or update it. The plugin wrote it. */
  async function requestSummary(text: string) {
    await mutate(async () => {
      apply(await enqueue(() => rpc.call("askAgent", { targetKey, ...SUMMARY_AT, body: text, inserted: true })) as { draft: Draft });
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
      // A comment replaces only the line's comment you were shown, if any: an edit box says when it changed as you wrote.
      const replaces = { replaces: shownComments.current.find((c) => sameLocation(c, { file, line: Number(line), side }))?.body ?? null };
      const result = await enqueue(() => rpc.call("saveDraftComment", { targetKey, ...(composerRevision.current ? { revision: composerRevision.current } : {}), ...replaces, comment: { file, line: Number(line), side, ...rangeOf({ line: Number(line), side, startLine, startSide }), chapterId: editing?.chapterId ?? activeChapterId, ...(severity ? { severity } : {}), ...(editing?.introduced === false ? { introduced: false as const } : {}), body: body.trim() } }));
      apply(result as { draft: Draft }); closeComposer();
      focusComment({ file, line: Number(line), side }, inline);
    }, (message) => {
      if (!mounted.current) return;
      refocusBox.current = true;
      if (!rebuilding && composerRevision.current !== revisionRef.current) { setOlderDiff(true); return "Not saved: it was written against an older diff."; }
      setComposerError(message);
      // A save refused for a comment the box wasn't shown: read it, so the next save replaces it.
      refresh();
    });
  }
  /** Add a ```suggestion block holding the box's lines as they read now, for the reviewer to edit in place. */
  function suggestChange() {
    if (!suggestable) return;
    // Longer than any backtick run in the lines, so a fence among them doesn't close the block.
    const fence = "`".repeat(Math.max(3, ...suggestable.flatMap((text) => text.match(/`+/g) ?? []).map((run) => run.length + 1)));
    const block = `${fence}suggestion\n${suggestable.join("\n")}\n${fence}`;
    const next = `${body.trimEnd() ? `${body.trimEnd()}\n\n` : ""}${block}`;
    // The PR's lines: the plugin's, not yours.
    if (filled.current) filled.current = [...filled.current, block];
    changeBody(next);
    requestAnimationFrame(() => {
      const box = bodyRef.current;
      // Typing goes at the end of the lines, before the closing fence.
      box?.focus(); box?.setSelectionRange(next.length - fence.length - 1, next.length - fence.length - 1);
    });
  }
  async function removeComment(comment: DraftComment) {
    const { file, line, side } = comment;
    // Putting back a comment on an older diff would bind it to the current one unchecked.
    const older = stale.some((at) => sameLocation(at, comment));
    // Why? opens from where it was, once its toast goes.
    const reason = askWhy && comment.author === "agent" ? { cancel: { label: "Why?", onClick: (event: { currentTarget: EventTarget | null }) => {
      const box = event.currentTarget instanceof Element ? event.currentTarget.getBoundingClientRect() : null;
      setWhy({ at: { file, line, side }, rect: box ? { left: box.left, top: box.top, width: box.width, height: box.height } : { left: window.innerWidth - 16, top: window.innerHeight - 16, width: 0, height: 0 } });
    } } } : null;
    const refocus = focusAfterRemoval();
    // Undo puts it back on the diff it was removed from: after a rebuild, the server refuses.
    const revision = revisionRef.current;
    await mutate(async () => {
      apply(await enqueue(() => rpc.call("removeDraftComment", { targetKey, file, line, side })) as { draft: Draft });
      refocus();
      if (older) { if (reason) toast.info("Comment removed", reason); else toast.info("Comment removed"); }
      else toast.info("Comment removed", { ...reason, action: { label: "Undo", onClick: () => { void latest.current.restoreComments([comment], revision); } } });
    });
  }
  /**
   * Set a comment's severity, or clear it, as its box would save it: over the comment as shown, pre-existing if it was, and
   * yours from then on.
   * One on an older diff waits for its box, whose save checks it against the current one.
   */
  async function setCommentSeverity(comment: DraftComment, next: Severity | undefined) {
    if (stale.some((at) => sameLocation(at, comment))) return;
    const { file, line, side, chapterId, introduced, body } = comment;
    await mutate(async () => {
      apply(await enqueue(() => rpc.call("saveDraftComment", { targetKey, ...(revisionRef.current ? { revision: revisionRef.current } : {}), replaces: body, comment: { file, line, side, ...rangeOf(comment), chapterId: chapterId ?? activeChapterId, ...(next ? { severity: next } : {}), ...(introduced === false ? { introduced } : {}), body } })) as { draft: Draft });
      // The comment's open box saves the severity it shows.
      if (editing && sameLocation(editing, comment)) setSeverity(next);
      toast.info(next ? SEVERITY_LABEL[next] : "No severity");
    });
  }
  /**
   * Make comments on an older diff lines of the summary, which is then yours. No Undo, as with Remove on an older diff:
   * putting one back would bind it to the current diff unchecked.
   */
  async function moveToSummary(comments: DraftComment[]) {
    await mutate(async () => {
      for (const { file, line, side } of comments) apply(await enqueue(() => rpc.call("moveToSummary", { targetKey, ...(revisionRef.current ? { revision: revisionRef.current } : {}), file, line, side })) as { draft: Draft });
      toast.info("Moved to the summary");
    });
  }
  /** Remove every nit; Undo puts back those drafted against the current diff. */
  async function removeNits() {
    const removed = draft.comments.filter((comment) => comment.severity === "nit");
    const restorable = removed.filter((comment) => !stale.some((at) => sameLocation(at, comment)));
    const revision = revisionRef.current;
    await mutate(async () => {
      for (const { file, line, side } of removed) apply(await enqueue(() => rpc.call("removeDraftComment", { targetKey, file, line, side })) as { draft: Draft });
      const text = `Removed ${removed.length} nit${removed.length === 1 ? "" : "s"}`;
      if (restorable.length) toast.info(text, { action: { label: "Undo", onClick: () => { void latest.current.restoreComments(restorable, revision); } } });
      else toast.info(text);
    });
  }
  /**
   * Put back comments you removed, as they were, on the diff they were removed from (`revision`), except where a line has
   * another comment by now.
   */
  async function restoreComments(comments: DraftComment[], revision: string | undefined) {
    const free = comments.filter(({ file, line, side }) => {
      const taken = shownComments.current.some((c) => sameLocation(c, { file, line, side }));
      if (taken) toast.info(`${file}:${line} has another comment now, so the removed one stays removed.`);
      return !taken;
    });
    if (!free.length) return;
    await mutate(async () => {
      for (const comment of free) {
        const { file, line, side, chapterId, author, severity, body, evidence, introduced } = comment;
        apply(await enqueue(() => rpc.call("saveDraftComment", { targetKey, ...(revision ? { revision } : {}), replaces: null, comment: { file, line, side, ...rangeOf(comment), ...(chapterId ? { chapterId } : {}), ...(author ? { author } : {}), ...(severity ? { severity } : {}), body, ...(evidence ? { evidence } : {}), ...(introduced === false ? { introduced } : {}) } })) as { draft: Draft });
      }
    });
  }
  /** Mark a comment as a problem in code the PR didn't change, or as from this PR; it stays whoever wrote it. */
  async function markPreExisting(comment: DraftComment, preExisting: boolean) {
    const { introduced: _introduced, ...rest } = comment;
    await mutate(async () => {
      apply(await enqueue(() => rpc.call("saveDraftComment", { targetKey, ...(revisionRef.current ? { revision: revisionRef.current } : {}), replaces: comment.body, comment: { ...rest, ...(preExisting ? { introduced: false as const } : {}) } })) as { draft: Draft });
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
  /**
   * Submit the draft; against the agent's suggestion or with the summary out of date, only once you confirm. What the
   * server warns about waits for `choice`: Submit anyway, or Submit as Comment.
   */
  async function submit(confirmed = false, choice?: "anyway" | "comment") {
    if (isLocal || !loaded || body.trim()) return;
    if ((doubts.length || approvingBlocked) && !confirmed) { setConfirming(true); requestAnimationFrame(() => confirmCancelRef.current?.focus()); return; }
    setConfirming(false);
    // Submit anyway goes past exactly the warnings shown: one that turned up since warns again.
    const past = choice === "anyway" ? warned?.warnings ?? [] : undefined;
    setWarned(null);
    setSubmitting(true);
    try { await mutate(async () => {
      // What this page shows; the server refuses a draft that changed since.
      const { verdict, body: summary } = draft;
      const result = await enqueue(() => rpc.call("submitReview", { targetKey, ...(reviewRevision ? { revision: reviewRevision } : {}), ...(account ? { account } : {}), comments: shownComments.current, body: summary, verdict,
        ...(past ? { force: past } : {}), ...(choice === "comment" ? { asComment: true } : {}) }));
      if (!result.ok && (result.warning || result.offers?.length)) {
        refresh();
        setWarned({ text: result.warning ?? result.error ?? "", offers: result.offers ?? [], warnings: result.warnings ?? [], ...(result.newCommits ? { newCommits: result.newCommits } : {}) });
        requestAnimationFrame(() => confirmCancelRef.current?.focus());
        return;
      }
      if (!result.ok) { refresh(); throw new Error(result.error ?? "Submit failed. Your draft is still here."); }
      setReceipt(choice === "comment" ? "COMMENT" : verdict); setReceiptUrl(result.url ?? null);
      setWriteAnother(false);
      onSubmitted?.();
      toast.success("Review submitted to GitHub");
      await load();
    }); } finally { if (mounted.current) setSubmitting(false); }
  }

  const canAdd = !busy && !rebuilding && !!file.trim() && !!body.trim() && Number.isInteger(Number(line)) && Number(line) >= 1;
  // A file's lines in the diff, read when a box opens on it: only the open box's file is needed.
  const positionsOf = useMemo(() => {
    let texts: Map<string, string> | undefined;
    const read = new Map<string, FilePositions | undefined>();
    return (path: string) => {
      if (!read.has(path)) {
        texts ??= new Map(splitPatchByFile(patch).map((f) => [f.path, f.text]));
        const text = texts.get(path);
        read.set(path, text === undefined ? undefined : diffPositions(text).get(path));
      }
      return read.get(path);
    };
  }, [patch]);
  // What the code draws of a file: narrowed to what changed since your review, only those hunks, and none of a file
  // unchanged since.
  const { compare, showLocation } = useWorkspace();
  const drawnOf = useCallback((path: string) => {
    const change = compare.narrowed ? compare.since?.get(path) : undefined;
    if (change?.status === "unchanged") return undefined;
    return change?.status === "changed" ? diffPositions(change.patch).get(path) : positionsOf(path);
  }, [compare.narrowed, compare.since, positionsOf]);
  const onLine = (shown: FilePositions | undefined) => !!(side === "LEFT" ? shown?.left : shown?.right)?.has(Number(line));
  // A box in the code on a line the code doesn't draw, as after a rebuild, a reload with one between, or with the diff
  // narrowed to what changed since, has no row to show under: it moves to the panel, whose fields say where it is and
  // can move it.
  useEffect(() => {
    if (!showComposer || !inline || summaryBox || !patch || onLine(drawnOf(file))) return;
    setInline(false);
    onOpenPanel?.("comments");
  }, [showComposer, inline, summaryBox, patch, drawnOf, file, line, side, onOpenPanel]);
  // A box in the panel on a line the diff has, but the code doesn't draw, narrowed to what changed since: Show in diff
  // shows all of it and moves the box under its line.
  const showBoxInDiff = showComposer && !inline && !summaryBox && !!patch && onLine(positionsOf(file)) && !onLine(drawnOf(file)) ? () => {
    showLocation(file, Number(line), side);
    setInline(true);
  } : null;
  // The new-file lines a comment's box is on, as they read now, for Suggest change; null on old-file lines.
  const suggestable = useMemo(() => {
    if (!showComposer || summaryBox || asking || side !== "RIGHT" || startSide) return null;
    const lines = positionsOf(file)?.right;
    const texts: string[] = [];
    for (let n = startLine ?? Number(line); n <= Number(line); n++) {
      const text = lines?.get(n);
      if (text === undefined) return null;
      texts.push(text);
    }
    return texts.length ? texts : null;
  }, [positionsOf, showComposer, summaryBox, asking, file, line, side, startLine, startSide]);
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
  // A new workspace of the review may already show its draft: the status goes with the last one.
  useEffect(() => holdReview("draft", targetKey, () => setDraftStatus(targetKey, null)), [targetKey]);
  // The diff shows the draft's comments and discussions, and the comment box while it's open there.
  const latest = useRef({ openComposer, removeComment, addComment, askAgent, dismissDiscussion, undo, changeBody, closeComposer, dropSummaryEdit, keepOnCurrentDiff, restoreComments, cancelComposer, suggestChange, markPreExisting });
  latest.current = { openComposer, removeComment, addComment, askAgent, dismissDiscussion, undo, changeBody, closeComposer, dropSummaryEdit, keepOnCurrentDiff, restoreComments, cancelComposer, suggestChange, markPreExisting };
  const open = useCallback((at: CommentLocation & { startLine?: number }, start?: CommentStart) => latest.current.openComposer(at, true, false, start), []);
  const ask = useCallback((at: CommentLocation) => latest.current.openComposer(at, true, true), []);
  const remove = useCallback((comment: DraftComment) => { void latest.current.removeComment(comment); }, []);
  const dismiss = useCallback((at: CommentLocation) => { void latest.current.dismissDiscussion(at); }, []);
  const undoAt = useCallback((at: CommentLocation) => { void latest.current.undo(at); }, []);
  const markAt = useCallback((comment: DraftComment, preExisting: boolean) => { void latest.current.markPreExisting(comment, preExisting); }, []);
  const editable = loaded && !loadError && !closed;
  // On your own PR, Comment is the only verdict GitHub takes.
  useEffect(() => { if (ownPr && editable && !isLocal && draft.verdict !== "COMMENT" && !pendingVerdict.current) chooseVerdict("COMMENT"); }, [ownPr, editable, isLocal, draft.verdict]);
  const writing = !!body.trim();
  const edited = writing && body !== openedBody.current;
  // A new comment's box on a line with a comment, such as the agent's, written as you wrote: saving replaces it.
  const replacing = showComposer && !editing && !asking && !summaryBox && draft.comments.some((c) => sameLocation(c, { file, line: Number(line), side }));
  // The comment an edit box is on, as the draft has it now, when it changed since the box opened, as by the agent: null
  // when it was removed.
  const editedNow = editing ? draft.comments.find((c) => sameLocation(c, editing)) ?? null : null;
  const changedWhileEditing = useMemo(() => editing && editedNow?.body !== editing.body ? { now: editedNow } : null, [editing, editedNow]);
  // A rebuild moved the comment being edited: the box goes with it, when it's the only one with its words in its file and
  // side that wasn't already there before. A comment that was there is another one, and the edited one was removed. Its
  // save still finds it written against an older diff.
  const previousComments = useRef(draft.comments);
  useEffect(() => {
    const before = previousComments.current;
    previousComments.current = draft.comments;
    if (!editing || editedNow?.body === editing.body) return;
    const moved = draft.comments.filter((c) => c.file === editing.file && c.side === editing.side && c.body === editing.body
      && !before.some((b) => sameLocation(b, c) && b.body === c.body));
    if (moved.length !== 1) return;
    const [comment] = moved;
    setLine(String(comment.line)); setStartLine(comment.startLine); setStartSide(comment.startSide);
    setEditing(comment);
  }, [draft.comments]); // eslint-disable-line react-hooks/exhaustive-deps
  const composerInDiff = editable && showComposer && inline;
  const chat = useMemo(() => onOpenPanel ? () => onOpenPanel("agent") : null, [onOpenPanel]);
  const editingLine = showComposer && !summaryBox && !asking;
  const inlineDraft = useMemo<InlineDraft>(() => ({
    targetKey, comments: draft.comments, stale, discussions: lineDiscussions, editable, busy, writing, hideNits, open, ask, remove, dismiss, undo: undoAt, markPreExisting: markAt, chat,
    composer: composerInDiff ? { file, line: Number(line), side, ...(startLine ? { startLine } : {}), editing: editing !== null, asking } : null,
    editingAt: editingLine ? { file, line: Number(line), side } : null,
  }), [targetKey, draft.comments, stale, lineDiscussions, editable, busy, writing, hideNits, open, ask, remove, dismiss, undoAt, markAt, chat, composerInDiff, editingLine, file, line, side, startLine, editing, asking]);
  const canSuggest = !!suggestable;
  const inlineComposer = useMemo<InlineComposer | null>(() => composerInDiff ? {
    body, edited, replacing, changedWhileEditing, textareaRef: bodyRef, error: composerError, rebuilding, keepOnCurrentDiff: olderDiff ? () => latest.current.keepOnCurrentDiff() : null,
    change: (text) => latest.current.changeBody(text),
    severity, changeSeverity: setSeverity,
    save: () => { void latest.current.addComment(); },
    askAgent: () => { void latest.current.askAgent(); },
    cancel: () => latest.current.cancelComposer(),
    suggest: canSuggest ? () => latest.current.suggestChange() : null,
  } : null, [composerInDiff, body, edited, replacing, changedWhileEditing, severity, composerError, rebuilding, olderDiff, canSuggest]);
  const summaryComposer = editable && onSummary ? {
    mode: asking ? "ask" as const : "edit" as const, body, edited, textareaRef: bodyRef,
    change: changeBody, save: () => { void saveSummary(body.trim()); }, askAgent: () => { void askAgent(); }, cancel: () => { closeComposer(); focusSummary(); },
  } : null;
  const hint = isLocal ? "Local review. Comments and notes stay in this BB installation."
    : writing ? asking ? "Send or cancel your message to the agent before submitting." : onSummary ? "Save or cancel the summary before submitting." : "Add the comment you’re writing to the draft before submitting."
    : rebuilding ? "The guide is rebuilding for new commits. Submit when it’s ready."
    : staleComments.length ? `The diff changed after these comments were drafted: ${staleComments.map((c) => `${c.file}:${c.line}`).join(", ")}. Edit or remove ${staleComments.length === 1 ? "it" : "them"}, or submit anyway to move ${staleComments.length === 1 ? "it" : "them"} into the summary.`
    : needsSummary ? "Requesting changes needs a summary: say what has to change."
    : "Drafts stay in BB until you submit.";
  const suggested = draft.suggestedVerdict;
  const changes = summaryChanges(draft);
  // A longer hint grows the footer over the end of the draft: keep the box you're typing in above it, its buttons
  // included where it all fits, else its top, as with the keyboard up (lib/use-keyboard-inset.ts).
  const composerControls = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = composerControls.current?.parentElement;
    if (box?.contains(document.activeElement)) box.scrollIntoView?.({ block: "nearest" });
  }, [hint]);
  // Approving with high-risk files not viewed, or chapters marked viewed faster than they read.
  const approval = draft.verdict === "APPROVE" && approveGuard && (approveGuard.unviewed.length || approveGuard.rushed.length) ? approveGuard : null;
  // The agent suggests Approve without having read every file worth reading.
  const unreadApproval = suggested === "APPROVE" && !ownPr && agentCoverage && agentCoverage.read < agentCoverage.total ? agentCoverage : null;
  // Why Submit asks once more: the agent suggested another verdict, its summary no longer fits, what an approval
  // skipped, or what the agent's suggested approval didn't read.
  const doubts = [
    ...(suggested && suggested !== draft.verdict && !ownPr ? [`The agent suggested ${VERDICT_LABEL[suggested]}.`] : []),
    ...(changes.comments && changes.verdict ? [`Your comments changed, and the summary was written for ${VERDICT_LABEL[changes.verdict]}.`]
      : changes.comments ? ["Your comments changed since the agent wrote the summary."]
      : changes.verdict ? [`The summary was written for ${VERDICT_LABEL[changes.verdict]}.`] : []),
    ...(approval ? approveDoubts(approval) : []),
    ...(unreadApproval ? [`The agent suggests Approve but read ${readOf(unreadApproval)}.`] : []),
  ];
  const commentCount = draft.comments.length;
  // Kept apart, a problem the PR didn't introduce doesn't count against Approve.
  const preExistingOn = useKnob("preExistingFindings");
  const preExistingCount = preExistingOn ? draft.comments.filter(isPreExisting).length : 0;
  const blocks = (comment: DraftComment) => comment.severity === "blocking" && !(preExistingOn && isPreExisting(comment));
  const blockingCount = draft.comments.filter(blocks).length;
  // Approving says nothing blocks; blocking comments in the draft say otherwise.
  const approvingBlocked = draft.verdict === "APPROVE" && blockingCount > 0;
  const counts = severityCounts(draft.comments);
  const nitCount = draft.comments.filter((comment) => comment.severity === "nit").length;
  return {
    targetKey, loadError, load, refresh, loaded, closed, review, draft, completed, submittedVerdict, receiptUrl, setWriteAnother, status,
    summaryRef, summaryDiscussion, editable, busy, submitting, writing, onSummary, summaryComposer, isLocal, chat, asking, summaryBase, openComposer, saveSummary, revisionRef, undo, requestSummary,
    showComposer, inline, edited, replacing, counts, preExistingCount, blocks, markPreExisting, hideNits, nitCount, toggleNits, removeNits, listRef, sortedComments, stale, discussions, body, removeComment, setCommentSeverity, moveToSummary,
    file, boxLines, line, side, files, setFile, editing, showBoxInDiff, startLine, setLine, setSide, bodyRef, changeBody, canAdd, addComment, cancelComposer, composerError, rebuilding, olderDiff, keepOnCurrentDiff, composerControls, severity, setSeverity, suggestable, suggestChange,
    changedWhileEditing, ownPr, suggested, chooseVerdict, confirming, setConfirming, warned, setWarned, approval, agentCoverage, unreadApproval, approvingBlocked, blockingCount, commentCount, doubts, hasReview, needsSummary, staleComments, submit, confirmCancelRef, submitRef, hint,
    inlineDraft, inlineComposer, askAgent, patch, account, why, setWhy,
  };
}
