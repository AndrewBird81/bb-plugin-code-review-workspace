import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../src/rpc-contract";
import type { FocusRun } from "../../src/focus-model";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { TOUCH_CONTROL } from "../touch";

/** A run's one status line, never a focus chat or a new alert. */
export function FocusStrip({ targetKey, run }: { targetKey: string; run?: FocusRun }) {
  const rpc = useRpc<typeof rpcContract>();
  const [stopping, setStopping] = useState(false);
  if (!run) return null;
  const active = run.state === "finding" || run.state === "merging";
  const failed = run.focuses.filter((focus) => focus.error);
  if (!active && !failed.length) return null;
  const text = active ? run.state === "finding" ? "Reviewing with focuses" : "Checking focus findings…"
    : failed.map((focus) => `${focus.label} didn't finish: ${focus.error}`).join(" · ");
  const stop = active && run.mergeDispatchedAt === undefined;
  return <div role="status" aria-live="polite" className="flex items-center gap-2 rounded-md bg-primary/5 px-3 py-2 text-sm">
    <Icon name="Sparkles" className="shrink-0 text-(--ansi-13)" aria-hidden />
    <span className="min-w-0 flex-1">{text}</span>
    {stop && <Button variant="outline" size="sm" className={TOUCH_CONTROL} disabled={stopping} onClick={() => {
      setStopping(true);
      void rpc.call("stopFocusRun", { targetKey }).finally(() => setStopping(false));
    }}>{stopping ? "Stopping…" : "Stop"}</Button>}
  </div>;
}
