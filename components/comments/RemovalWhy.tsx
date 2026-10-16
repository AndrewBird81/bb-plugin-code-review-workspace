import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../src/rpc-contract";
import type { CommentLocation } from "../../src/draft";
import { REMOVAL_NOTE_LIMIT, REMOVAL_REASON_LABEL, REMOVAL_REASONS, type RemovalReasonId } from "../../lib/removal-reasons";
import { cn } from "../../lib/utils";
import { useWorkspace } from "../../lib/workspace-context";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { CompactViewportOverrideProvider } from "../ui/hooks/use-compact-viewport";
import { Input } from "../ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";

/** Why? on "Comment removed", for the agent's comment at `at`: where the button was, for the popover to open from. */
export interface WhyRequest { at: CommentLocation; rect: { left: number; top: number; width: number; height: number } }

const CHOICE = cn("h-7 px-2 text-xs aria-pressed:border-primary/50 aria-pressed:bg-primary/10 aria-pressed:text-primary", TOUCH_CONTROL);

/**
 * Why you removed the agent's comment: a reason saves with one tap, and a line of your own saves with it. A popover from
 * where Why? was, a drawer on a phone.
 */
export function RemovalWhy({ request, onClose }: { request: WhyRequest; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const { targetKey, layout } = useWorkspace();
  const [reason, setReason] = useState<RemovalReasonId | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function send(next: RemovalReasonId, line: string): Promise<boolean> {
    setBusy(true);
    try {
      const { ok } = await rpc.call("setRemovalReason", { targetKey, ...request.at, reason: next, ...(line.trim() ? { note: line.trim() } : {}) });
      if (!ok) toast.error("Couldn’t save why: the removal is gone, or Settings stopped asking.");
      return ok;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t save why. Try again.");
      return false;
    } finally { setBusy(false); }
  }
  async function pick(next: RemovalReasonId) {
    setReason(next);
    if (!await send(next, note)) setReason(null);
  }
  async function save() {
    if (reason && await send(reason, note)) onClose();
  }
  const { rect } = request;
  // Kit popovers open as bottom drawers where the workspace is phone-sized or short, as the workspace's do.
  return <CompactViewportOverrideProvider isCompactViewport={layout.mode !== "tablet"}>
    <Popover open onOpenChange={(open) => { if (!open) onClose(); }}>
      <PopoverAnchor asChild><span aria-hidden className="pointer-events-none fixed" style={rect} /></PopoverAnchor>
      <PopoverContent side="top" align="end" mobileTitle="Why did you remove it?" className="w-80 space-y-3 p-3">
        <p className="text-sm font-medium">Why did you remove it?</p>
        <div role="group" aria-label="Reason" className="flex flex-wrap gap-1.5">
          {REMOVAL_REASONS.map((id) => <Button key={id} variant="outline" size="sm" aria-pressed={reason === id} disabled={busy} className={CHOICE} onClick={() => void pick(id)}>{REMOVAL_REASON_LABEL[id]}</Button>)}
        </div>
        <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Input aria-label="Your note, optional" placeholder="Add a note (optional)" maxLength={REMOVAL_NOTE_LIMIT} value={note} className="h-8 min-w-0 flex-1 text-sm" onChange={(event) => setNote(event.target.value)} />
          <Button type="submit" size="sm" className={cn("h-8", TOUCH_CONTROL)} disabled={busy || !reason}>Save</Button>
        </form>
      </PopoverContent>
    </Popover>
  </CompactViewportOverrideProvider>;
}
