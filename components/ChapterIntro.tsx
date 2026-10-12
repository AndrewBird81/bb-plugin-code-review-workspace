import { memo, useId, useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { getIntroCollapsed, setIntroCollapsed } from "../lib/panel-state";
import { cn } from "../lib/utils";
import { useWorkspace } from "../lib/workspace-context";
import { Badge } from "./ui/badge";
import { Icon } from "./ui/icon";
import { InlineCode } from "./ui/inline-code";
import { MetaLine } from "./MetaLine";
import { RISK_LABEL, RISK_TONE } from "./ChapterNav";
import { TOUCH_CONTROL } from "./touch";

/**
 * The open chapter above its diff: where it is in the guide, its risk and size, its title, full overview, and what to
 * verify. Hiding the overview sticks in this browser.
 */
export const ChapterIntro = memo(function ChapterIntro({ index, total, title, overview, risk, focus, lines, collapsedByDefault = false }: {
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
}) {
  const { sections, files } = useWorkspace();
  const [chosen, setCollapsed] = useState(getIntroCollapsed);
  const collapsed = chosen ?? collapsedByDefault;
  const titleId = useId();
  const chapterFiles = sections[index]?.diffs ?? [];
  const viewed = chapterFiles.filter((diff) => files.views.get(diff.file)?.viewed).length;
  function toggle() {
    setIntroCollapsed(!collapsed);
    setCollapsed(!collapsed);
  }
  return (
    <section aria-labelledby={titleId} className="mb-4 rounded-lg border border-border bg-card px-4 py-3 shadow-xs">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <MetaLine className="tabular-nums" items={[
            `Chapter ${index + 1} of ${total}`,
            // Low risk is the usual case: only Medium and High say so.
            risk && risk !== "low" && <Badge tone={RISK_TONE[risk] ?? "neutral"} size="sm" className="align-[-2px]">{RISK_LABEL[risk] ?? risk}</Badge>,
            `${chapterFiles.length} ${chapterFiles.length === 1 ? "file" : "files"}`,
            lines > 0 && `${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"}`,
            `${viewed} of ${chapterFiles.length} viewed`,
          ]} />
          <h3 id={titleId} className="mt-1 text-sm font-semibold leading-snug text-foreground"><InlineCode text={title} /></h3>
        </div>
        {overview && (
          <button
            type="button"
            aria-label={collapsed ? "Show chapter overview" : "Hide chapter overview"}
            aria-expanded={!collapsed}
            className={cn("-mr-1 -mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", TOUCH_CONTROL)}
            onClick={toggle}
          >
            <Icon name="ChevronDown" className={cn("size-3.5 transition-transform duration-150", collapsed && "-rotate-90")} aria-hidden />
          </button>
        )}
      </div>
      {overview && !collapsed && <Markdown content={overview} className="mt-2 max-w-[80ch] text-sm leading-relaxed text-foreground/90" />}
      {!!focus?.length && !collapsed && (
        <div className="mt-2.5 max-w-[80ch] text-xs">
          <p className="flex items-center gap-1.5 font-medium text-foreground"><Icon name="ListTodo" className="size-3.5 text-primary" aria-hidden />What to verify</p>
          <ul aria-label="What to verify" className="mt-1 list-disc space-y-0.5 pl-5 text-foreground/90 marker:text-subtle-foreground">
            {focus.map((item) => <li key={item}><InlineCode text={item} /></li>)}
          </ul>
        </div>
      )}
    </section>
  );
});
ChapterIntro.displayName = "ChapterIntro";
