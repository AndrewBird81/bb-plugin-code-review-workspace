import { memo, useContext, useId, useLayoutEffect, useRef, useState } from "react";
import { Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import { ASK_LIFETIME } from "../src/asks";
import { getIntroCollapsed, setIntroCollapsed } from "../lib/panel-state";
import { useFullscreenPortalContainer } from "../lib/portal-scope";
import { useKnob, useSettings } from "../lib/settings";
import { cn } from "../lib/utils";
import { useWorkspace } from "../lib/workspace-context";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { Icon } from "./ui/icon";
import { InlineCode } from "./ui/inline-code";
import { InlineDraftContext } from "./InlineDraft";
import { MetaLine } from "./MetaLine";
import { RISK_LABEL, RISK_TONE } from "./ChapterNav";
import { TOUCH_CONTROL } from "./touch";

/**
 * Dig deeper on a medium- or high-risk chapter, unless Settings turns it off: the review agent's closer pass over it, at
 * high effort. While the agent is on it, from the click until its turn ends, the chapter says so instead.
 */
function useDeepDive(chapterId: string | undefined, risk: string | undefined) {
  const rpc = useRpc<typeof rpcContract>();
  const { targetKey, review } = useWorkspace();
  const on = useKnob("digDeeper");
  const model = useSettings().preferences.assistantAgent?.model;
  // An archived PR's draft can't change, so nothing would come of it.
  const editable = useContext(InlineDraftContext)?.editable ?? false;
  const [sending, setSending] = useState(false);
  const running = review.deepDive && Date.now() - review.deepDive.ask.at < ASK_LIFETIME ? review.deepDive.chapterId : null;
  const offered = on && editable && !!chapterId && (risk === "medium" || risk === "high");
  async function dig() {
    if (!chapterId || sending) return;
    setSending(true);
    try {
      const result = await rpc.call("digDeeper", { targetKey, chapterId });
      if (!result.ok) toast.error(result.error ?? "The agent couldn’t start.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The agent couldn’t start.");
    } finally { setSending(false); }
  }
  return {
    offered,
    digging: offered && (sending || running === chapterId),
    /** Another chapter's deep dive is under way. */
    elsewhere: !!running && running !== chapterId,
    hint: ["Review agent", model, "high effort"].filter(Boolean).join(" · "),
    dig,
  };
}

/**
 * The open chapter above its diff: where it is in the guide, its risk and size, its title, full overview, and what to
 * verify. Hiding the overview sticks in this browser. On a phone (`brief`) the overview shows three lines until More,
 * and what to verify one line until you open it, so the code starts on screen. A re-review's switch goes in it
 * (`switchSlot`): on its first row where there's room, else under the title, so it costs the code no block of its own.
 * What to verify ends with Dig deeper on a medium- or high-risk chapter.
 */
export const ChapterIntro = memo(function ChapterIntro({ index, total, title, overview, risk, focus, lines, collapsedByDefault = false, brief = false, switchSlot }: {
  index: number;
  total: number;
  title: string;
  overview: string;
  risk?: string;
  /** The guide's 1–3 "Check that…" items. */
  focus?: string[];
  /** The chapter's changed lines worth reading (lib/review-size.ts chapterReadingLines). */
  lines: number;
  /** Hide the overview until you show it, unless you chose in this browser. */
  collapsedByDefault?: boolean;
  /** A phone's: the overview cut to three lines, and what to verify to one. */
  brief?: boolean;
  /** Takes the element the diff puts its switch in. */
  switchSlot?: (el: HTMLDivElement | null) => void;
}) {
  const { sections, files } = useWorkspace();
  const deepDive = useDeepDive(sections[index]?.id, risk);
  const container = useFullscreenPortalContainer();
  const [chosen, setCollapsed] = useState(getIntroCollapsed);
  const collapsed = chosen ?? collapsedByDefault;
  const titleId = useId();
  const chapterFiles = sections[index]?.diffs ?? [];
  const viewed = chapterFiles.filter((diff) => files.views.get(diff.file)?.viewed).length;
  const [more, setMore] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const clamp = brief && !more;
  // More shows only where three lines cut the overview short, measured as the width changes.
  const overviewBox = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = overviewBox.current;
    if (!el || !clamp) return;
    const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [clamp, overview, collapsed]);
  // Low risk is the usual case: only Medium and High say so.
  const riskLabel = risk && risk !== "low" ? RISK_LABEL[risk] ?? risk : "";
  const facts = [
    `Chapter ${index + 1} of ${total}`,
    riskLabel,
    `${chapterFiles.length} ${chapterFiles.length === 1 ? "file" : "files"}`,
    lines > 0 && `${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"}`,
    `${viewed} of ${chapterFiles.length} viewed`,
  ];
  const checks = focus ?? [];
  const listed = checks.length > 0 && (!brief || verifying);
  function toggle() {
    setIntroCollapsed(!collapsed);
    setCollapsed(!collapsed);
  }
  return (
    <section aria-labelledby={titleId} className="group/intro @container/intro mb-4 grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-x-0 rounded-lg border border-border bg-card px-4 py-3 shadow-xs">
      <div className="col-start-1 row-start-1 min-w-0">
        {/* Beside the switch, one line cut short at its end (its title has it whole), not lines that push the code
            down. */}
        <MetaLine className="tabular-nums @min-[494px]/intro:group-has-[[role=radiogroup]]/intro:truncate" title={facts.filter(Boolean).join(" · ")} items={[
          facts[0],
          riskLabel && <Badge tone={RISK_TONE[risk ?? ""] ?? "neutral"} size="sm" className="align-[-2px]">{riskLabel}</Badge>,
          ...facts.slice(2),
        ]} />
        <h3 id={titleId} className="mt-1 text-sm font-semibold leading-snug text-foreground"><InlineCode text={title} /></h3>
      </div>
      {overview && (
        <button
          type="button"
          aria-label={collapsed ? "Show chapter overview" : "Hide chapter overview"}
          aria-expanded={!collapsed}
          className={cn("col-start-3 row-start-1 -mr-1 -mt-0.5 ml-2 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", TOUCH_CONTROL)}
          onClick={toggle}
        >
          <Icon name="ChevronDown" className={cn("size-3.5 transition-transform duration-150", collapsed && "-rotate-90")} aria-hidden />
        </button>
      )}
      {/* By CSS, so it moves in the same layout as a turn: the scroll anchor puts your place back after both. From a
          card about 528px wide (a pane about 560px), on the first row; else under the title, where it's read. Margins,
          not the grid's gap, space the columns, so an empty slot costs the facts no width. Under a 340px card its
          segments pad less: BB's small text is 14px in a window under 768px, and the switch then fits the 316px of a
          folded Duo. */}
      {switchSlot && <div ref={switchSlot} className="col-span-full mt-2 empty:hidden @max-[340px]/intro:[&_[role=radio]]:px-1.5 @min-[494px]/intro:ml-2 @min-[494px]/intro:mt-0 @min-[494px]/intro:[grid-column:2] @min-[494px]/intro:[grid-row:1]" />}
      {overview && !collapsed && <div ref={overviewBox} className={cn("col-span-full mt-2 max-w-[80ch]", clamp && "max-h-[4.25rem] overflow-hidden", clamp && clipped && "[mask-image:linear-gradient(to_bottom,black_2.75rem,transparent)]")}>
        <Markdown content={overview} className="text-sm leading-relaxed text-foreground/90" />
      </div>}
      {brief && !collapsed && (checks.length > 0 || clipped) && (
        <div className="col-span-full mt-1 flex flex-wrap items-center gap-x-4 text-xs pointer-coarse:-mb-2">
          {checks.length > 0 && <button type="button" aria-expanded={verifying} onClick={() => setVerifying(!verifying)} className={cn("flex items-center gap-1.5 rounded-sm font-medium text-foreground", TOUCH_CONTROL)}>
            <Icon name="ListTodo" className="size-3.5 text-primary" aria-hidden />What to verify<span className="font-normal text-muted-foreground"> · {checks.length}</span>
            <Icon name="ChevronRight" className={cn("size-3.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", verifying && "rotate-90")} aria-hidden />
          </button>}
          {clipped && <button type="button" aria-expanded={more} onClick={() => setMore(!more)} className={cn("inline-flex items-center gap-0.5 rounded-sm text-muted-foreground hover:text-foreground", checks.length > 0 && "ml-auto", TOUCH_CONTROL)}>
            {more ? "Less" : "More"}<Icon name={more ? "ChevronUp" : "ChevronDown"} className="size-3" aria-hidden />
          </button>}
        </div>
      )}
      {listed && !collapsed && (
        <div className={cn("col-span-full max-w-[80ch] text-xs", brief ? "mt-1" : "mt-2.5")}>
          {!brief && <p className="flex items-center gap-1.5 font-medium text-foreground"><Icon name="ListTodo" className="size-3.5 text-primary" aria-hidden />What to verify</p>}
          <ul aria-label="What to verify" className={cn("list-disc space-y-0.5 pl-5 text-foreground/90 marker:text-subtle-foreground", !brief && "mt-1")}>
            {checks.map((item) => <li key={item}><InlineCode text={item} /></li>)}
          </ul>
          {deepDive.offered && !deepDive.digging && (
            <Hint label={deepDive.hint} container={container}>
              <Button variant="outline" size="sm" className={cn("mt-2 h-7 border-(--ansi-13)/30 text-(--ansi-13) hover:text-(--ansi-13)", TOUCH_CONTROL)} disabled={deepDive.elsewhere} onClick={() => void deepDive.dig()}>
                <Icon name="Sparkles" className="size-3.5" aria-hidden />Dig deeper
              </Button>
            </Hint>
          )}
        </div>
      )}
      {/* Whether What to verify shows or not. */}
      {deepDive.digging && (
        <p role="status" className="col-span-full mt-2 flex items-center gap-1.5 text-xs text-(--ansi-13)">
          <Icon name="Loading" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />The agent is digging into this chapter…
        </p>
      )}
    </section>
  );
});
ChapterIntro.displayName = "ChapterIntro";
