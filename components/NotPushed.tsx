// Not pushed yet, in the Main thread tab on a PR (src/own-pr.ts): what the folder of the thread working on it has that
// the PR's head on GitHub doesn't, committed or not, file by file, read when it shows and again on Refresh.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { experimental_useCodeTheme, useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../src/rpc-contract";
import { splitPatchByFile } from "../src/patch";
import { cn } from "../lib/utils";
import { TOUCH_CONTROL } from "./touch";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { DiffStat } from "./ui/diff-stat";
import { ReadOnlyDiff } from "./DiffViewer";

type Read = z.infer<typeof rpcContract.getNotPushed.output>;

/** A file's lines added and removed in its diff. */
function counts(text: string): { added: number; removed: number } {
  const lines = text.split("\n").filter((line) => !line.startsWith("+++") && !line.startsWith("---"));
  return { added: lines.filter((line) => line.startsWith("+")).length, removed: lines.filter((line) => line.startsWith("-")).length };
}

const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

/** A file, folded under its name and size; its diff, as the review's code reads, draws once opened. */
function FileDetails({ text, themeMode, children }: { text: string; themeMode?: "light" | "dark"; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group rounded-lg border border-border bg-card">
    {children}
    {open && <div className="border-t border-border"><ReadOnlyDiff text={text} themeMode={themeMode} /></div>}
  </details>;
}

/** Not pushed yet: read while `active`, each file's diff folded under its name. */
export function NotPushed({ targetKey, active }: { targetKey: string; active: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [read, setRead] = useState<Read | null>(null);
  const [reading, setReading] = useState(false);
  const load = useCallback(() => {
    setReading(true);
    rpc.call("getNotPushed", { targetKey }).then(setRead, (failure) => setRead({ state: "unavailable", message: failure instanceof Error ? failure.message : "Couldn’t read the folder. Try again." }))
      .finally(() => setReading(false));
  }, [rpc, targetKey]);
  useEffect(() => { if (active) load(); }, [active, load]);
  const parts = read?.state === "available" ? splitPatchByFile(read.patch) : [];
  const themeMode = experimental_useCodeTheme().mode;
  // Each file's diff draws only while it's open.
  return <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 text-sm">
    <div className="flex items-start gap-2">
      <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">
        {!read ? "Reading the folder…"
          : read.state !== "available" ? read.message
          : <><span className="block text-sm font-medium text-foreground">{parts.length ? `${files(parts.length)}${read.machine ? ` on ${read.machine}` : ""} ${parts.length === 1 ? "isn’t" : "aren’t"} on GitHub yet` : "Everything here is on GitHub"}</span>
            <span className="block">Branch <span className="font-mono">{read.branch}</span> · compared with <span className="font-mono">{read.base.slice(0, 7)}</span></span></>}
      </p>
      <Button variant="ghost" size="sm" className={cn("h-7 shrink-0 px-2 text-xs text-muted-foreground", TOUCH_CONTROL)} aria-disabled={reading || undefined} onClick={() => { if (!reading) load(); }}>
        <Icon name={reading ? "Loading" : "ArrowReloadHorizontal"} className={cn("size-3.5", reading && "animate-spin motion-reduce:animate-none")} aria-hidden />Refresh
      </Button>
    </div>
    {read?.state === "available" && <>
      {read.notice && <p className="text-xs text-warning-text">{read.notice}</p>}
      {read.hidden.length > 0 && <p className="text-xs text-muted-foreground">{read.hidden.length === 1 ? "1 file that looks like a secret, or is binary or too large, isn’t shown." : `${read.hidden.length} files that look like secrets, or are binary or too large, aren’t shown.`}</p>}
      <ul aria-label="Not pushed yet" className="space-y-1.5">
        {parts.map((part) => {
          const { added, removed } = counts(part.text);
          return <li key={part.path}>
            <FileDetails text={part.text} themeMode={themeMode}>
              <summary className={cn("flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden", TOUCH_CONTROL)}>
                <Icon name="ChevronRight" className="size-3.5 shrink-0 text-subtle-foreground transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono" title={part.path}>{part.path}</span>
                <DiffStat add={added} del={removed} />
              </summary>
            </FileDetails>
          </li>;
        })}
      </ul>
    </>}
  </div>;
}
