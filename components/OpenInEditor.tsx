import { useState } from "react";
import { experimental_FileLink as FileLink } from "@get-bb/plugin-sdk/app";
import type { DraftComment } from "../src/draft";
import { useEditorFile } from "../lib/review-links";
import { cn } from "../lib/utils";
import { TOUCH_COMPACT, TOUCH_CONTROL } from "./touch";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

const at = (line: number | null) => line && line > 0 ? { kind: "line" as const, line, column: null } : null;

/** A local review's file row: Open in editor, at `line` when given. BB decides where: its preview, its editor, or yours. */
export function FileEditorLink({ file, line }: { file: string; line: number | null }) {
  const target = useEditorFile(file);
  if (!target) return null;
  return <Button asChild variant="ghost" size="sm" className={cn("h-6 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground", TOUCH_COMPACT)}>
    <FileLink target={target} location={at(line)} aria-label={`Open ${file} in editor`}><Icon name="Code" className="size-3" aria-hidden />Open in editor</FileLink>
  </Button>;
}

/** ⋯ on a local review's comment, with Open in editor at its first line. None for a comment on removed lines, which the checkout doesn't have. */
export function CommentEditorMenu({ comment, className }: { comment: DraftComment; className?: string }) {
  const target = useEditorFile(comment.file);
  const [open, setOpen] = useState(false);
  if (!target || comment.side !== "RIGHT" || (comment.startSide ?? comment.side) !== "RIGHT") return null;
  const line = comment.startLine ?? comment.line;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="sm" aria-label={`More on the comment on ${comment.file}:${line}`} className={cn("h-7 w-7 px-0 text-xs text-muted-foreground", TOUCH_CONTROL, className)}><Icon name="MoreHorizontal" className="size-3.5" aria-hidden /></Button>
    </PopoverTrigger>
    <PopoverContent align="end" mobileTitle="Comment" className="w-56 p-1">
      <Button asChild variant="ghost" size="sm" className={cn("w-full justify-start text-muted-foreground hover:text-foreground", TOUCH_CONTROL)}>
        <FileLink target={target} location={at(line)} onClick={() => setOpen(false)}><Icon name="Code" aria-hidden />Open in editor at line {line}</FileLink>
      </Button>
    </PopoverContent>
  </Popover>;
}
