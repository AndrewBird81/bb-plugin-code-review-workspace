import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../src/rpc-contract";
import { cn } from "../../lib/utils";
import { TOUCH_CONTROL } from "../touch";
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
  /** The icon and the action sit on the text's first line, however many it wraps to. */
  firstLine?: boolean;
}

const TONE = {
  danger: "bg-destructive/10 text-destructive-text",
  warning: "bg-warning/10 text-warning-text",
  info: "bg-primary/5 text-foreground",
} as const;

/**
 * Whether the PR has moved on from its guide, by commits or a new base branch, or a local review's code has, and the
 * notice that says so; asked again each time the review changes.
 */
export function useNewCommits(targetKey: string, enabled: boolean): { newCommits: boolean; text: string } {
  const rpc = useRpc<typeof rpcContract>();
  const [update, setUpdate] = useState<{ hasNewCommits: boolean; current?: string; stored?: string; baseChanged?: { from: string; to: string }; localChanged?: boolean }>({ hasNewCommits: false });
  const check = useCallback(() => {
    if (!enabled) return;
    // Without an answer there's nothing to say.
    rpc.call("checkForUpdates", { targetKey }).then(setUpdate, () => {});
  }, [rpc, targetKey, enabled]);
  useEffect(check, [check]);
  useRealtime(`review:${targetKey}`, check);
  const base = update.baseChanged;
  const text = update.localChanged ? "The code changed since this guide."
    : !base ? "New commits since this guide was written."
    : update.current !== update.stored ? `New commits, and the PR’s base changed from ${base.from} to ${base.to}, since this guide was written.`
    : `The PR’s base changed from ${base.from} to ${base.to} since this guide was written.`;
  return { newCommits: enabled && (update.hasNewCommits || !!update.localChanged), text };
}

/**
 * The review's notices, under the band: the first, most pressing, and "+N" to show the rest beneath it. They go into
 * one polite live region that stays mounted, empty when there are none, as a region inserted with its text isn't always
 * announced.
 */
export function ReviewNotices({ notices }: { notices: Notice[] }) {
  const [expanded, setExpanded] = useState(false);
  const more = notices.length - 1;
  return (
    <div aria-live="polite" className={cn("shrink-0", notices.length > 0 && "border-b border-border")}>
      {(expanded ? notices : notices.slice(0, 1)).map((notice, index) => (
        <div key={notice.id} role={notice.role ?? "status"} aria-label={notice.label} className={cn("flex min-h-9 flex-wrap gap-x-2 gap-y-1 px-3 py-1 text-xs", notice.firstLine ? "items-baseline" : "items-center", TONE[notice.tone], index > 0 && "border-t border-border")}>
          {/* Aligned on its baseline, the icon's foot is on the text's: down a little, it's centred on the first line. */}
          <Icon name={notice.icon} className={cn("size-3.5 shrink-0", notice.firstLine && "translate-y-[3px]", notice.tone === "info" && "text-primary", notice.busy && "animate-spin motion-reduce:animate-none")} aria-hidden />
          {/* Wrapping, the text keeps room for two lines' worth, and the action goes under it rather than squeeze it to three. */}
          <span className={cn("min-w-0 flex-1", notice.firstLine && "basis-56")}>{notice.text}</span>
          {/* At the end of its line, or of the one it wraps to. */}
          {notice.firstLine && notice.action ? <span className="ml-auto flex">{notice.action}</span> : notice.action}
          {index === 0 && more > 0 && (
            <Button variant="ghost" size="sm" aria-expanded={expanded} aria-label={expanded ? "Show fewer notices" : `${more} more notice${more === 1 ? "" : "s"}`} className={cn("h-7 px-2 text-xs tabular-nums", TOUCH_CONTROL)} onClick={() => setExpanded(!expanded)}>
              {expanded ? <Icon name="ChevronUp" aria-hidden /> : `+${more}`}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
