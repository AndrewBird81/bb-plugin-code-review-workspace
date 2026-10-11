import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../src/rpc-contract";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Icon, type IconName } from "../ui/icon";

/** Something about the review to know or fix: what it says, and the click that answers it. */
export interface Notice {
  id: string;
  tone: "danger" | "warning" | "info";
  icon: IconName;
  /** Work under way: the icon turns. */
  busy?: boolean;
  /** "alert" for what went wrong; others are news, "status". */
  role?: "alert" | "status";
  /** The notice's name for screen readers, when its text doesn't say what it's about. */
  label?: string;
  text: ReactNode;
  action?: ReactNode;
}

const TONE = {
  danger: "bg-destructive/10 text-destructive-text",
  warning: "bg-warning/10 text-warning-text",
  info: "bg-primary/5 text-foreground",
} as const;

/** Whether the PR has commits its guide wasn't written for; asked again each time the review changes. */
export function useNewCommits(targetKey: string, enabled: boolean): boolean {
  const rpc = useRpc<typeof rpcContract>();
  const [newCommits, setNewCommits] = useState(false);
  const check = useCallback(() => {
    if (!enabled) return;
    // Without an answer there's nothing to say.
    rpc.call("checkForUpdates", { targetKey }).then((result) => setNewCommits(result.hasNewCommits), () => {});
  }, [rpc, targetKey, enabled]);
  useEffect(check, [check]);
  useRealtime(`review:${targetKey}`, check);
  return enabled && newCommits;
}

/** The review's notices, under the band: the first, most pressing, and "+N" to show the rest beneath it. */
export function ReviewNotices({ notices }: { notices: Notice[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!notices.length) return null;
  const more = notices.length - 1;
  return (
    <div className="shrink-0 border-b border-border">
      {(expanded ? notices : notices.slice(0, 1)).map((notice, index) => (
        <div key={notice.id} role={notice.role ?? "status"} aria-label={notice.label} className={cn("flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 text-xs", TONE[notice.tone], index > 0 && "border-t border-border")}>
          <Icon name={notice.icon} className={cn("size-3.5 shrink-0", notice.tone === "info" && "text-primary", notice.busy && "animate-spin motion-reduce:animate-none")} aria-hidden />
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.action}
          {index === 0 && more > 0 && (
            <Button variant="ghost" size="sm" aria-expanded={expanded} aria-label={expanded ? "Show fewer notices" : `${more} more notice${more === 1 ? "" : "s"}`} className="h-7 px-2 text-xs tabular-nums pointer-coarse:h-9" onClick={() => setExpanded(!expanded)}>
              {expanded ? <Icon name="ChevronUp" aria-hidden /> : `+${more}`}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
