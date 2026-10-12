import type { FeedbackView } from "../../lib/feedback";
import { cn } from "../../lib/utils";
import { age } from "../time-ago";
import { TOUCH_CONTROL } from "../touch";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

/**
 * The agent's check of your threads on GitHub, at the top of Comments: "✦ Agent's check · a1b2c3d · 2h · 2 of 3
 * addressed", "older commit" when it checked an earlier push, "Checking your feedback…" while it runs, and Check again.
 */
export function CheckStrip({ run, tally, running, starting, onCheck }: {
  run: FeedbackView["run"];
  /** "2 of 3 addressed"; null before a check. */
  tally: string | null;
  /** The agent is checking now. */
  running: boolean;
  /** Check again was pressed and is starting. */
  starting: boolean;
  onCheck: () => void;
}) {
  const when = run ? age(run.assessedAt) : null;
  return (
    <div role="status" className="flex min-h-11 items-center gap-2 rounded-lg border border-(--ansi-13)/25 bg-(--ansi-13)/5 py-1 pl-2.5 pr-1 text-xs">
      <Icon name={running ? "Loading" : "Sparkles"} className={cn("size-3.5 shrink-0 text-(--ansi-13)", running && "animate-spin motion-reduce:animate-none")} aria-hidden />
      <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground">
        {running ? <span className="text-foreground">Checking your feedback…</span>
          : run ? <>
            <span className="font-medium text-foreground">Agent’s check</span>
            <span aria-hidden>·</span><span className="font-mono">{run.headSha.slice(0, 7)}</span>
            {when && <><span aria-hidden>·</span><span>{when}</span></>}
            {tally && <><span aria-hidden>·</span><span className="font-medium tabular-nums text-foreground/90">{tally}</span></>}
            {!run.current && <Badge tone="warning" size="sm" title="The agent checked an earlier commit than the PR’s head.">older commit</Badge>}
          </>
          : <span>The agent hasn’t checked your feedback on this push yet.</span>}
      </p>
      <Button variant="outline" size="sm" className={cn("h-7 shrink-0 gap-1.5 px-2 text-xs", TOUCH_CONTROL)} disabled={running || starting} onClick={onCheck}>
        {starting ? "Checking…" : "Check again"}
      </Button>
    </div>
  );
}
