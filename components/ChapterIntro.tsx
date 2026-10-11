import { memo, useId, useState } from "react";
import { Markdown } from "@get-bb/plugin-sdk/app";
import { getIntroCollapsed, setIntroCollapsed } from "../lib/panel-state";
import { cn } from "../lib/utils";
import { Badge } from "./ui/badge";
import { Icon } from "./ui/icon";
import { InlineCode } from "./ui/inline-code";
import { RISK_LABEL, RISK_TONE } from "./ChapterNav";

/** The open chapter's title, risk, and full overview, above its diff. Hiding the overview sticks in this browser. */
export const ChapterIntro = memo(function ChapterIntro({ index, total, title, overview, risk, collapsedByDefault = false }: {
  index: number;
  total: number;
  title: string;
  overview: string;
  risk?: string;
  /** Hide the overview until you show it, unless you chose in this browser. */
  collapsedByDefault?: boolean;
}) {
  const [chosen, setCollapsed] = useState(getIntroCollapsed);
  const collapsed = chosen ?? collapsedByDefault;
  const titleId = useId();
  function toggle() {
    setIntroCollapsed(!collapsed);
    setCollapsed(!collapsed);
  }
  return (
    <section aria-labelledby={titleId} className="mb-4 rounded-lg border border-border bg-card px-4 py-3 shadow-xs">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] tabular-nums text-subtle-foreground">Chapter {index + 1} of {total}</p>
          <h3 id={titleId} className="text-sm font-semibold leading-snug text-foreground"><InlineCode text={title} /></h3>
        </div>
        {risk && <Badge tone={RISK_TONE[risk] ?? "neutral"} size="sm" className="mt-0.5">{RISK_LABEL[risk] ?? risk}</Badge>}
        {overview && (
          <button
            type="button"
            aria-label={collapsed ? "Show chapter overview" : "Hide chapter overview"}
            aria-expanded={!collapsed}
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
            onClick={toggle}
          >
            <Icon name="ChevronDown" className={cn("size-3.5 transition-transform duration-150", collapsed && "-rotate-90")} aria-hidden />
          </button>
        )}
      </div>
      {overview && !collapsed && <Markdown content={overview} className="mt-2 max-w-[80ch] text-sm leading-relaxed text-foreground/90" />}
    </section>
  );
});
ChapterIntro.displayName = "ChapterIntro";
