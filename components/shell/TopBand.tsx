import { useFullscreenPortalContainer } from "../../lib/portal-scope";
import { cn } from "../../lib/utils";
import { useWorkspace } from "../../lib/workspace-context";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { Icon } from "../ui/icon";
import { TOUCH_CONTROL } from "../touch";

/** The id of the navigator's host, which the chapters toggle shows and hides. */
export const navigatorId = (targetKey: string) => `gr-navigator-${targetKey}`;

/**
 * The band's first controls, which never move: the chapters toggle, beside Find in review's box at the navigator's
 * top, and with a Find in review button where the navigator isn't docked to hold the box (`find`).
 */
export function TopBand({ find = false }: { find?: boolean }) {
  const { nav, targetKey } = useWorkspace();
  const container = useFullscreenPortalContainer();
  const button = cn("size-8 shrink-0 px-0 text-muted-foreground aria-pressed:text-foreground", TOUCH_CONTROL);
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Hint label="Chapters" container={container}>
        <Button variant="ghost" size="sm" aria-label={nav.open ? "Hide chapters" : "Show chapters"} aria-pressed={nav.open} aria-controls={navigatorId(targetKey)} className={button} onClick={nav.toggle}>
          <Icon name="ListView" aria-hidden />
        </Button>
      </Hint>
      {find && <Hint label="Find in review (/)" container={container}>
        <Button variant="ghost" size="sm" aria-label="Find in review" className={button} onClick={nav.find}>
          <Icon name="Search" aria-hidden />
        </Button>
      </Hint>}
    </div>
  );
}
