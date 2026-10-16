import { useState } from "react";
import type { DraftComment } from "../../src/draft";
import { summaryLine } from "../../lib/move-to-summary";
import { useKnob } from "../../lib/settings";
import { cn } from "../../lib/utils";
import { useDraft } from "../DraftProvider";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

/**
 * Move to summary, for comments on an older diff: a small confirm shows the lines it adds to your summary, and Move adds
 * them and removes the comments. Nothing while Settings turns it off.
 */
export function MoveToSummary({ comments, variant = "ghost", className }: { comments: DraftComment[]; variant?: "ghost" | "outline"; className?: string }) {
  const draft = useDraft();
  const on = useKnob("moveToSummary");
  const preExisting = useKnob("preExistingFindings");
  const [open, setOpen] = useState(false);
  if (!on || !draft.editable || !comments.length) return null;
  const lines = comments.map((comment) => summaryLine(comment, preExisting));
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button variant={variant} size="sm" className={className} disabled={draft.busy || draft.writing}>Move to summary</Button>
    </PopoverTrigger>
    <PopoverContent align="end" mobileTitle="Move to summary" className="w-96 max-w-[calc(100vw-2rem)] space-y-2 p-3">
      <p className="text-sm">{lines.length === 1 ? "Adds this line to your summary and removes the comment:" : `Adds these lines to your summary and removes the ${lines.length} comments:`}</p>
      <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-xs text-muted-foreground">{lines.join("\n")}</pre>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" className={TOUCH_CONTROL} onClick={() => setOpen(false)}>Cancel</Button>
        <Button size="sm" className={cn(TOUCH_CONTROL)} onClick={() => { setOpen(false); void draft.moveToSummary(comments); }}>Move</Button>
      </div>
    </PopoverContent>
  </Popover>;
}
