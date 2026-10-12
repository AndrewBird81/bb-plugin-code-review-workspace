import { useEffect } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { cn } from "../../lib/utils";
import { timeAgo } from "../time-ago";
import { TOUCH_COMPACT, TOUCH_CONTROL } from "../touch";
import { TONE_TEXT } from "../ui/badge";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { Icon } from "../ui/icon";
import { mountListTitleBar, useInboxBar } from "./inbox-store";

/**
 * The list's controls, in BB's title bar: Find a review where the page has no room for its box (a phone), Refresh, and
 * Settings. `placement="page"`: the page shows them itself, where BB has no title bar for them.
 */
export function ListTitleBar({ placement = "title" }: { placement?: "title" | "page" }) {
  // Told even while it shows nothing, so the page knows not to show them itself.
  useEffect(() => placement === "title" ? mountListTitleBar() : undefined, [placement]);
  const inbox = useInboxBar();
  const navigate = useBbNavigate();
  if (!inbox) return null;
  const read = timeAgo(inbox.health?.lastReadAt);
  // BB's 48px bar keeps buttons to 36px on a coarse pointer, inside 44px targets.
  const button = cn("size-8 shrink-0 px-0 text-muted-foreground aria-expanded:text-foreground", placement === "title" ? TOUCH_COMPACT : TOUCH_CONTROL);
  return (
    <div role="group" aria-label="Review list commands" className="flex shrink-0 items-center gap-1">
      {!inbox.searchInline && <Hint label="Find a review">
        <Button variant="ghost" size="sm" aria-label="Find a review" aria-expanded={inbox.searchOpen} className={button} onClick={inbox.openSearch}>
          <Icon name="Search" aria-hidden />
        </Button>
      </Hint>}
      <Hint label={read ? `Refresh · GitHub read ${read}` : "Refresh"}>
        <Button variant="ghost" size="sm" aria-label={inbox.refreshing ? "Refreshing…" : "Refresh"} disabled={inbox.refreshing} className={button} onClick={inbox.refresh}>
          <Icon name="ArrowReloadHorizontal" className={cn(inbox.refreshing && "animate-spin motion-reduce:animate-none", inbox.health?.error && TONE_TEXT.warning)} aria-hidden />
        </Button>
      </Hint>
      <Hint label="Settings">
        <Button variant="ghost" size="sm" aria-label="Settings" className={button} onClick={() => navigate.toPluginPanel("review", { subPath: "settings" })}>
          <Icon name="Settings" aria-hidden />
        </Button>
      </Hint>
    </div>
  );
}
