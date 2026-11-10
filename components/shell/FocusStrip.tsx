import { useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../src/rpc-contract";
import type { FocusFinding, FocusRun } from "../../src/focus-model";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { useMediaQuery } from "../ui/hooks/use-media-query";
import { TOUCH_CONTROL } from "../touch";

/** A run's one status line, never a focus chat or a new alert. */
export function FocusStrip({ targetKey, run, head, latestHead, updateAction, findings = [], generalWorking = false }: {
  targetKey: string; run?: FocusRun; head?: string | null; latestHead?: string; updateAction?: ReactNode;
  findings?: readonly FocusFinding[]; generalWorking?: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const compact = useMediaQuery("(max-width: 440px)");
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const active = run?.state === "finding" || run?.state === "merging";
  const needsUpdate = !!run && run.head === head && !!latestHead && latestHead !== head;
  const stop = active && run?.mergeDispatchedAt === undefined;
  let text: ReactNode = "";
  if (run) {
    const failed = run.focuses.filter((focus) => focus.error);
    const unchecked = findings.filter((finding) => finding.status === "not-checked").length;
    const older = !!head && head !== run.head || needsUpdate;
    if (active) {
      const done = run.focuses.filter((focus) => ["done", "failed", "stopped"].includes(focus.state)).length;
      const slots = run.focuses.filter((focus) => focus.state === "running").length;
      const counts = `${done} of ${run.focuses.length} done`;
      const statuses = run.focuses.map((focus, index) => <span key={focus.focusId} className="inline-flex items-center gap-1">
        {index > 0 && " · "}{focus.label}{focus.state === "running" ? <>…<Icon name="Loading" className="size-3 animate-spin motion-reduce:animate-none" aria-hidden /></> : focus.state === "queued" ? " waiting" : focus.state === "done" ? " ✓" : " ✕"}
      </span>);
      text = compact ? `Focuses · ${counts}` : run.state === "finding"
        ? <>Reviewing with focuses · General {generalWorking ? "…" : "✓"} · {run.focuses.length > 3 ? counts : statuses} · using {slots} agent slot{slots === 1 ? "" : "s"}</>
        : `Checking ${run.focuses.reduce((sum, focus) => sum + (focus.findings ?? 0), 0)} focus findings…`;
    } else if (dismissed !== run.id) {
      text = [
        ...failed.map((focus) => `${focus.label} didn't finish: ${focus.error}`),
        older ? run.head.startsWith("diff:") ? "The focuses ran on an older diff." : `The focuses ran on ${run.head.slice(0, 7)}, an older commit.` : "",
        needsUpdate ? "Update the review’s diff first to check the new commits." : "",
        unchecked ? `${unchecked} finding${unchecked === 1 ? "" : "s"} not checked.` : "",
        run.state === "stopped" ? "The focus run stopped." : "",
      ].filter(Boolean).join(" · ");
    }
  }
  const visible = !!text;
  async function act(method: "stopFocusRun" | "rerunFocusRun") {
    setBusy(true);
    try {
      const result = await rpc.call(method, { targetKey });
      if (!result.ok) toast.error("error" in result ? result.error : "The focuses couldn’t stop. Try again.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Something went wrong"); }
    finally { setBusy(false); }
  }
  return <div className={visible ? "flex items-center gap-2 rounded-md bg-primary/5 px-3 py-2 text-sm" : "contents"}>
    {visible && <Icon name="Sparkles" className="shrink-0 text-(--ansi-13)" aria-hidden />}
    {/* Keep the live region mounted before its text arrives; controls aren't part of its announcement. */}
    <span role="status" aria-live="polite" aria-atomic="true" className={visible ? "min-w-0 flex-1 break-words" : "sr-only"}>{text}</span>
    {visible && stop && <Button variant="outline" size="sm" className={TOUCH_CONTROL} disabled={busy} onClick={() => void act("stopFocusRun")}>{busy ? "Stopping…" : "Stop"}</Button>}
    {visible && !active && <div className="flex shrink-0 flex-wrap gap-1">
      {needsUpdate ? updateAction : <Button variant="outline" size="sm" className={TOUCH_CONTROL} disabled={busy} onClick={() => void act("rerunFocusRun")}>Run again</Button>}
      <Button variant="ghost" size="sm" className={TOUCH_CONTROL} onClick={() => setDismissed(run!.id)}>Got it</Button>
    </div>}
  </div>;
}
