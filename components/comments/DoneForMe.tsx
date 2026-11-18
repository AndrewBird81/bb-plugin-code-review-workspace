import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../src/rpc-contract";
import { cn } from "../../lib/utils";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

export function DoneForMe({ targetKey, id, latest, undo = false, className }: {
  targetKey: string; id: string; latest: number | null; undo?: boolean; className?: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  async function change() {
    setBusy(true);
    try {
      const result = await rpc.call("setDoneForMe", { targetKey, id, done: !undo, latest: undo ? null : latest });
      if (!result.ok) toast.error("Couldn’t change Done for me.");
    } catch { toast.error("Couldn’t change Done for me."); }
    finally { setBusy(false); }
  }
  return <Button variant="ghost" size="sm" className={cn("h-7 px-2 text-xs text-muted-foreground", TOUCH_CONTROL, className)} disabled={busy} onClick={() => void change()}>
    {!undo && <Icon name="Lock" className="size-3.5" aria-hidden />}{undo ? "Undo" : "Done for me"}
  </Button>;
}

/** One line in the code and list; Undo changes BB alone. */
export function DoneLine({ targetKey, id, latest, github, who, body, className }: {
  targetKey: string; id: string; latest: number | null; github?: "Open" | "Resolved"; who: string; body: string; className?: string;
}) {
  const first = body.split("\n").find((line) => line.trim()) ?? "";
  return <div className={cn("flex min-w-0 items-center gap-1 rounded-lg border border-border bg-muted/30 px-2 py-1 text-xs text-muted-foreground", className)}>
    <Icon name="Lock" className="size-3.5 shrink-0" aria-hidden />
    <span className="min-w-0 flex-1 truncate">Done for me{github && ` · GitHub: ${github}`} · {who}: {first}</span>
    <DoneForMe targetKey={targetKey} id={id} latest={latest} undo />
  </div>;
}
