import type { ReactNode } from "react";
import type { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import type { ReviewMenuItem } from "./ReviewActions";
import { TOUCH_CONTROL } from "./touch";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

/**
 * The bar of a page with no band: back (to All reviews, or as `back` says), the page's title, and its menu
 * (`children`). A review without a guide (tracked, building, failed) and Settings have it, so leaving and the review's
 * actions are always a tap away, where the review itself has them in its band and BB's title bar.
 */
export function PageBar({ back = "All reviews", onBack, backDisabled = false, title, children }: {
  back?: string;
  onBack(): void;
  backDisabled?: boolean;
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="@container/pagebar flex h-11 shrink-0 items-center gap-1 border-b border-border px-1.5">
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1 text-sm">
        <Button variant="ghost" size="sm" disabled={backDisabled} className={cn("h-8 shrink-0 gap-1 px-1.5 text-muted-foreground", TOUCH_CONTROL)} onClick={onBack}>
          {/* Under 480px, ‹ alone, still named for where it goes. */}
          <Icon name="ChevronLeft" aria-hidden /><span className="@max-[480px]/pagebar:sr-only">{back}</span>
        </Button>
        {title && <>
          <span aria-hidden className="text-subtle-foreground @max-[480px]/pagebar:hidden">/</span>
          {/* Two lines fit the bar's 44px, so a phone shows more of a long title than its first words. A review's id chip
              sits on its first line's baseline, and its name wraps beside it (ReviewTitle). */}
          <h1 className="flex min-w-0 items-baseline gap-2 font-medium leading-4.5 text-foreground">{typeof title === "string" ? <span className="line-clamp-2 min-w-0 break-words">{title}</span> : title}</h1>
        </>}
      </nav>
      {children}
    </div>
  );
}

/** Review settings…, for the menu of a review page without a guide: Settings' back comes to the review. */
export function reviewSettingsItem(navigate: ReturnType<typeof useBbNavigate>, targetKey: string): ReviewMenuItem {
  return { label: "Review settings…", icon: "Settings", onSelect: () => navigate.toPluginPanel("review", { subPath: `settings/${targetKey}` }) };
}
