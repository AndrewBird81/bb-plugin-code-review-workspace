import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../src/rpc-contract";
import type { ReviewLifecycle } from "../../src/store";
import { prDraftWaiting, pushFlagText } from "../../lib/push";
import { cn } from "../../lib/utils";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import type { Notice } from "./ReviewNotices";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

/** A branch, a commit or a path in monospace, breaking only after a / or a - where it must. */
export function Mono({ text }: { text: string }) {
  const pieces = text.split(/(?<=[/-])/);
  return <span className="font-mono [overflow-wrap:anywhere]">{pieces.map((piece, i) => <span key={i}>{i > 0 && <wbr />}{piece}</span>)}</span>;
}

/** Push's copy (lib/push.ts): `code` in monospace, **bold** in bold. */
export function Marked({ text }: { text: string }): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`\n]+`)/g).map((part, i) =>
    part.length > 4 && part.startsWith("**") && part.endsWith("**") ? <strong key={i} className="font-semibold"><Marked text={part.slice(2, -2)} /></strong>
    : part.length > 2 && part.startsWith("`") && part.endsWith("`") ? <Mono key={i} text={part.slice(1, -1)} />
    : part);
}

/** Update: read the folder again, to review what changed, then clear the Push it answers. */
export async function updateThenClear(rpc: Rpc, targetKey: string): Promise<{ ok: boolean; error?: string }> {
  const updated = await rpc.call("updateFeature", { targetKey });
  return updated.ok ? rpc.call("dismissPush", { targetKey }) : updated;
}

/** The PR drafts said ready, by review and when each was shown, so each is said once while the page stays open. */
const draftsSaid = new Set<string>();

/**
 * "The PR draft is ready.", once per draft, while the review agent's Post form waits in its chat (ReviewMeta.prDraft):
 * a toast with Post PR…, which opens the agent's tab (`onPost`), unless Finish review shows (`finishShown`), which says it.
 */
export function usePrDraftToast(targetKey: string, review: Pick<ReviewLifecycle, "prDraft"> | null, finishShown: boolean, onPost: () => void) {
  const post = useRef(onPost);
  post.current = onPost;
  const at = review && prDraftWaiting(review)?.at;
  useEffect(() => {
    if (!at || draftsSaid.has(`${targetKey}:${at}`)) return;
    draftsSaid.add(`${targetKey}:${at}`);
    if (!finishShown) toast.info("The PR draft is ready.", { action: { label: "Post PR…", onClick: () => post.current() } });
  }, [targetKey, at, finishShown]);
}

/**
 * The notice for a flagged Push (src/push.ts), plainly, on the review. GitHub isn't at the commit after the push: a
 * warning, with Push again, Main thread ↗ and Got it. The branch has commits that didn't come from Push, a teammate's
 * or CI's as often as a thread's: news, with Update to review them and Got it. `onChanged` reloads the review.
 */
export function usePushNotices(targetKey: string, review: Pick<ReviewLifecycle, "push"> & { kind?: "pr" | "ref" } | null, onChanged: () => void): Notice[] {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [busy, setBusy] = useState(false);
  const run = review?.push;
  const text = pushFlagText(run);
  if (!text || !run) return [];
  const act = (call: () => Promise<{ ok: boolean; error?: string; note?: string }>, done?: string) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await call();
      if (!result.ok) toast.error(result.error ?? "Something went wrong. Try again.");
      else {
        if (result.note) toast.info(result.note.replace(/[`*]/g, ""));
        else if (done) toast.success(done);
        onChanged();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const button = (label: ReactNode, onClick: () => void, warning: boolean) => <Button variant="outline" size="sm" className={cn("h-7", warning && "border-warning/40", TOUCH_CONTROL)} disabled={busy} onClick={onClick}>{label}</Button>;
  const gotIt = (warning: boolean) => button("Got it", () => void act(() => rpc.call("dismissPush", { targetKey }))(), warning);
  if (run.flag === "unrequested") {
    return [{ id: "push-flagged", tone: "info", icon: "GitCommit", role: "status", label: "New commits on GitHub", firstLine: true, text: <Marked text={text} />,
      // A PR's new commits show as its own: only a local review's folder updates here.
      action: <span className="flex flex-wrap gap-2">{review?.kind !== "pr" && button("Update", () => void act(() => updateThenClear(rpc, targetKey), "Updated. Review what changed.")(), false)}{gotIt(false)}</span> }];
  }
  return [{ id: "push-flagged", tone: "warning", icon: "AlertTriangle", role: "alert", label: "Push not on GitHub", firstLine: true, text: <Marked text={text} />,
    action: <span className="flex flex-wrap gap-2">
      {button("Push again", () => void act(() => rpc.call("push", { targetKey }))(), true)}
      {button(<>Main thread<Icon name="ArrowUpRight" className="size-3.5" aria-hidden /></>, () => navigate.toThread(run.threadId), true)}
      {gotIt(true)}
    </span> }];
}
