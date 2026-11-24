import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../src/rpc-contract";
import type { PassStage, ReviewPass } from "../../src/review-pass";
import type { FocusRun } from "../../src/focus-model";
import { getReviewState, patchReviewState } from "../../lib/panel-state";
import { useKnob } from "../../lib/settings";
import { cn } from "../../lib/utils";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import type { Notice } from "./ReviewNotices";

const BUTTON = cn("h-7", TOUCH_CONTROL);
const STAGES: Array<Exclude<PassStage, "done">> = ["reading", "guide", "focuses", "merging"];
const STAGE_TEXT: Record<Exclude<PassStage, "done">, string> = {
  reading: "reading the diff",
  guide: "updating the guide",
  focuses: "running focuses",
  merging: "merging findings",
};
/** The notices a review's out-of-date state shows, which Update review answers. */
export const OUT_OF_DATE = new Set(["new-commits", "folder-changed", "guide-behind"]);

/**
 * Update review (src/review-pass.ts startPass), for PR and folder reviews alike, and the pass's one notice: its stage
 * while it runs, with Stop where its stage has one (the guide's, the focuses'), then what came back, with Got it.
 */
export function useReviewPass(targetKey: string, review: { status?: string; reviewPass?: ReviewPass; focusRun?: FocusRun } | null, onChanged: () => void) {
  const rpc = useRpc<typeof rpcContract>();
  const stopGenerating = useKnob("stopGenerating");
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const [dismissed, setDismissed] = useState(() => ({ targetKey, passId: getReviewState(targetKey).dismissedPass }));
  const dismissedPass = dismissed.targetKey === targetKey ? dismissed.passId : getReviewState(targetKey).dismissedPass;
  const pass = review?.reviewPass;
  const running = pass?.state === "pending";

  const call = async (what: "start" | "stop", run: () => Promise<{ ok: boolean; error?: string }>, failed: string) => {
    if (busy) return;
    setBusy(what);
    try {
      const result = await run();
      if (!result.ok) toast.error(result.error ?? failed);
      else onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : failed);
    } finally { setBusy(null); }
  };
  const start = () => void call("start", () => rpc.call("startPass", { targetKey }), "Couldn’t update the review.");
  const updateReview = <Button variant="outline" size="sm" className={BUTTON} aria-disabled={!!busy || running || undefined} onClick={() => { if (!running) start(); }}>{busy === "start" ? "Updating review…" : "Update review"}</Button>;

  const notices: Notice[] = [];
  if (pass && running) {
    const stage = pass.stage === "done" ? "merging" : pass.stage;
    const run = review?.focusRun;
    const stop = stage === "guide" && stopGenerating && review?.status === "generating"
      ? () => void call("stop", () => rpc.call("stopGuide", { targetKey }), "Couldn’t stop the guide.")
      : stage === "focuses" && run?.passId === pass.id && run.state === "finding" && run.mergeDispatchedAt === undefined
        ? () => void call("stop", () => rpc.call("stopFocusRun", { targetKey }), "The focuses couldn’t stop. Try again.")
        : null;
    notices.push({ id: "pass", tone: "info", icon: "Loading", busy: true, label: "Updating the review",
      text: `Updating the review: ${STAGE_TEXT[stage]} (${STAGES.indexOf(stage) + 1} of ${STAGES.length}).`,
      ...stop ? { action: <Button variant="outline" size="sm" className={BUTTON} aria-disabled={!!busy || undefined} onClick={stop}>{busy === "stop" ? "Stopping…" : "Stop"}</Button> } : {} });
  } else if (pass && dismissedPass !== pass.id) {
    const gotIt = <Button variant="ghost" size="sm" className={BUTTON} onClick={() => {
      patchReviewState(targetKey, { dismissedPass: pass.id });
      setDismissed({ targetKey, passId: pass.id });
    }}>Got it</Button>;
    const n = pass.findings?.length ?? 0;
    const found = n ? `${n} finding${n === 1 ? "" : "s"}` : "No findings";
    notices.push(pass.state === "failed"
      ? { id: "pass", tone: "danger", icon: "AlertTriangle", role: "alert", label: "Review update failed", text: <>Couldn’t update the review.<span className="mt-0.5 line-clamp-3 whitespace-pre-line break-words">{pass.error ?? "The pass failed."}</span></>, action: <span className="flex gap-1">{updateReview}{gotIt}</span> }
      : pass.state === "incomplete"
        ? { id: "pass", tone: "warning", icon: "AlertTriangle", label: "Review update incomplete", text: <>Review updated, but incomplete: {found}.{pass.summary && <span className="mt-0.5 line-clamp-3 whitespace-pre-line break-words">{pass.summary}</span>}</>, action: gotIt }
        : { id: "pass", tone: "info", icon: n ? "MessageSquare" : "CircleCheck", label: "Review updated", text: `Review updated: ${found}.`, action: gotIt });
  }
  return { notices, updateReview, running };
}
