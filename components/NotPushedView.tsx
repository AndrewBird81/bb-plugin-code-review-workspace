// Not pushed yet, the review's page after its chapters, on a PR whose main thread works in a folder (src/own-pr.ts):
// what that folder has that the PR's head on GitHub doesn't, committed or not, read when it opens and again on Refresh,
// in the review's own diff. A new line takes a LOCAL comment there; a removed one is the PR's head's line, which takes
// a comment in the PR's diff, once the review's diff is at that head. A local review has no page of its own: its diff is its folder already.
// Viewed is kept per file revision, as chapters keep it per diff; its end says comments here go with Send, with Push and Finish review.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SelectedLineRange } from "@pierre/diffs";
import { experimental_useCodeTheme, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { z } from "zod";
import type { rpcContract } from "../src/rpc-contract";
import type { CommentLocation } from "../src/draft";
import { splitPatchByFile } from "../src/patch";
import { diffPositions } from "../src/review-positions";
import { pushTarget } from "../lib/push";
import { useKnob } from "../lib/settings";
import { cn } from "../lib/utils";
import { useWorkspace } from "../lib/workspace-context";
import { setNotPushedFiles } from "../lib/workspace-store";
import { useDraft } from "./DraftProvider";
import { DiffViewer, type FileViewFlags } from "./DiffViewer";
import { InlineDraftContext, type InlineDraft } from "./InlineDraft";
import { TOUCH_CONTROL } from "./touch";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

type Read = z.infer<typeof rpcContract.getNotPushed.output>;

const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

/**
 * The page: its header says how many files, on which machine, from which branch against which of the PR's commits, with
 * Refresh; then their diff, and its end. `reveal`: a LOCAL comment's line, from Comments.
 */
export function NotPushedView({ reveal }: { reveal?: { at: CommentLocation; nonce: number } }) {
  const { targetKey, review, patch, display, followUp } = useWorkspace();
  const { localDraft } = useDraft();
  const rpc = useRpc<typeof rpcContract>();
  const [read, setRead] = useState<Read | null>(null);
  const [reading, setReading] = useState(false);
  const load = useCallback(() => {
    setReading(true);
    rpc.call("getNotPushed", { targetKey }).then(setRead, (failure) => setRead({ state: "unavailable", message: failure instanceof Error ? failure.message : "Couldn’t read the folder. Try again." }))
      .finally(() => setReading(false));
  }, [rpc, targetKey]);
  useEffect(load, [load]);
  const shown = read?.state === "available" ? read.patch : "";
  const paths = useMemo(() => splitPatchByFile(shown).map((part) => part.path), [shown]);
  useEffect(() => { if (read?.state === "available") setNotPushedFiles(targetKey, paths.length); }, [targetKey, read, paths.length]);
  // Viewed folds a file, kept for its revision here: apart from the chapters' Viewed, whose files are the PR's.
  const [views, setViews] = useState<Map<string, FileViewFlags>>(() => new Map());
  useEffect(() => { if (read?.state === "available") setViews(new Map(read.views.map(({ file, ...flags }) => [file, flags]))); }, [read]);
  const viewsNow = useRef(views);
  viewsNow.current = views;
  const toggleViewed = useCallback((file: string, viewed: boolean) => {
    const before = viewsNow.current.get(file);
    const put = (flags: FileViewFlags | undefined) => setViews((now) => {
      const next = new Map(now);
      if (flags) next.set(file, flags);
      else next.delete(file);
      return next;
    });
    put({ viewed, stale: false });
    rpc.call("setNotPushedViewed", { targetKey, file, viewed }).then((saved) => { if (!saved.ok) throw new Error(); }).catch(() => {
      put(before);
      toast.error("Couldn’t save Viewed.");
    });
  }, [rpc, targetKey]);
  // The PR's diff's new side, which a removed line here is: the line at the PR's head, when the review's diff is at it,
  // or else only where that diff has the same line at the same number.
  const onPr = useMemo(() => diffPositions(patch), [patch]);
  const here = useMemo(() => diffPositions(shown), [shown]);
  const onReviewHead = read?.state === "available" && read.onReviewHead;
  const draft = useMemo<InlineDraft>(() => ({
    ...localDraft,
    open: (at, start) => {
      if (at.side !== "LEFT") return localDraft.open(at.side === "LOCAL" ? at : { ...at, side: "LOCAL" }, start);
      const prLine = onPr.get(at.file)?.right.get(at.line);
      if (prLine !== undefined && (onReviewHead || prLine === here.get(at.file)?.left.get(at.line))) return followUp(at.file, at.line, "RIGHT");
      toast.info(!onReviewHead ? "The PR has new commits. Update first."
        : onPr.has(at.file) ? "That line isn’t in the PR’s diff. Comment on it in All changes." : "The PR doesn’t change this file, so GitHub takes no comment on it.");
    },
  }), [localDraft, onPr, here, onReviewHead, followUp]);
  // Picked lines open a comment on them: a range on one side, which the draft checks is in one hunk.
  const pick = useCallback((file: string, range: SelectedLineRange | null) => {
    if (!range || !draft.editable) return;
    const side = (range.endSide ?? range.side) === "deletions" ? "LEFT" : "RIGHT";
    const from = Math.min(range.start, range.end), to = Math.max(range.start, range.end);
    draft.open({ file, line: to, side, ...from < to && (!range.endSide || range.endSide === range.side) ? { startLine: from } : {} });
  }, [draft]);
  const themeMode = experimental_useCodeTheme().mode;
  const count = paths.length;
  return <section aria-label="Not pushed yet" className="space-y-4">
    <div className="flex items-start gap-2">
      <div role="status" className="min-w-0 flex-1">
        {!read ? <p className="text-sm text-muted-foreground">Reading the folder…</p>
          : read.state !== "available" ? <p className="text-sm text-muted-foreground">{read.message}</p>
          : <>
            <h2 className="text-lg font-semibold text-foreground">{count ? `${files(count)}${read.machine ? ` on ${read.machine}` : ""} ${count === 1 ? "isn’t" : "aren’t"} on GitHub yet` : "Everything here is on GitHub"}</h2>
            <p className="text-xs text-muted-foreground">Branch <span className="font-mono">{read.branch}</span> · compared with {review.number ? <>PR #{review.number} (<span className="font-mono">{read.base.slice(0, 7)}</span>)</> : <span className="font-mono">{read.base.slice(0, 7)}</span>}</p>
          </>}
      </div>
      <Button variant="outline" size="sm" className={cn("h-7 shrink-0 gap-1.5 px-2 text-xs", TOUCH_CONTROL)} aria-disabled={reading || undefined} onClick={() => { if (!reading) load(); }}>
        <Icon name={reading ? "Loading" : "ArrowReloadHorizontal"} className={cn("size-3.5", reading && "animate-spin motion-reduce:animate-none")} aria-hidden />Refresh
      </Button>
    </div>
    {read?.state === "available" && <>
      {read.notice && <p className="text-xs text-warning-text">{read.notice}</p>}
      {read.hidden.length > 0 && <p className="text-xs text-muted-foreground">{read.hidden.length === 1 ? "1 file that looks like a secret, or is binary or too large, isn’t shown." : `${read.hidden.length} files that look like secrets, or are binary or too large, aren’t shown.`}</p>}
      {count > 0 && <InlineDraftContext.Provider value={draft}>
        <DiffViewer patch={read.patch} files={paths} views={views} onToggleViewed={toggleViewed} onLineSelected={pick} reveal={reveal}
          diffLayout={display.layout} wrapLines={display.wrap} hideWhitespace={display.hideWhitespace} themeMode={themeMode}
          newFiles={display.newFiles} onNewFiles={display.setNewFiles} markdownFiles={display.markdownFiles} />
      </InlineDraftContext.Provider>}
      {count > 0 && <NotPushedFooter />}
    </>}
  </section>;
}

/**
 * The page's end: comments here go with Send, not Submit; Push, where the review has one, which shows how it goes in
 * Finish review; and Finish review.
 */
function NotPushedFooter() {
  const { targetKey, review, openFinish } = useWorkspace();
  const rpc = useRpc<typeof rpcContract>();
  const sendOn = useKnob("sendToThread");
  const [busy, setBusy] = useState(false);
  const pushable = sendOn && typeof pushTarget(review) !== "string";
  async function push() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await rpc.call("push", { targetKey });
      if (!result.ok) return void toast.error(result.error ?? "Couldn’t push. Try again.");
      if (result.note) toast.info(result.note.replace(/[`*]/g, ""));
      openFinish();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn’t push. Try again.");
    } finally { setBusy(false); }
  }
  const button = cn("min-w-0 max-w-full @max-[480px]/review:w-full", TOUCH_CONTROL);
  return <div className="mt-6 flex flex-wrap items-center justify-end gap-x-4 gap-y-2 border-t border-border pt-4">
    <p className="mr-auto text-xs text-muted-foreground">Comments here go with Send, not Submit.</p>
    {/* Where the pane is phone-sized, each button takes a row of its own. */}
    <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 @max-[480px]/review:w-full">
      {pushable && <Button variant="outline" size="sm" className={cn("gap-1.5 aria-disabled:opacity-60", button)} aria-disabled={busy || undefined} onClick={() => void push()}>
        <Icon name={busy ? "Loading" : "ArrowUp"} className={cn(busy && "animate-spin motion-reduce:animate-none")} aria-hidden />Push
      </Button>}
      <Button size="sm" className={button} onClick={() => openFinish()}>Finish review<Icon name="ArrowRight" aria-hidden /></Button>
    </div>
  </div>;
}
