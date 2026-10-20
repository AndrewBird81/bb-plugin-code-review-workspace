import { useContext, useMemo, useRef } from "react";
import { chapterAt } from "../../src/hunks";
import { splitPatchByFile } from "../../src/patch";
import { draftState } from "../../lib/comments";
import { cn } from "../../lib/utils";
import { useWorkspace } from "../../lib/workspace-context";
import { InlineDraftContext } from "../InlineDraft";
import { MetaLine } from "../MetaLine";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { InlineCode } from "../ui/inline-code";
import { plural } from "../../lib/plural";

const basename = (file: string) => file.slice(file.lastIndexOf("/") + 1);
/** How many files not viewed yet the last chapter's end names. */
const NAMED = 3;

/**
 * The end of a chapter: how much of it you've viewed and commented on, then on to the next, marking it viewed if you
 * like. The last chapter's next step is finishing, and it names the files you haven't viewed yet in the others.
 */
export function ChapterFooter({ patch }: {
  /** The diff, to place a comment on a file split across chapters by its hunk. */
  patch: string;
}) {
  const { review, sections, activeId, files, go, openFinish } = useWorkspace();
  const draft = useContext(InlineDraftContext);
  // chapterAt splits the patch it's given: give it just the comment's file, split once per patch.
  const texts = useMemo(() => new Map(splitPatchByFile(patch).map((file) => [file.path, file.text])), [patch]);
  const root = useRef<HTMLDivElement>(null);
  const index = sections.findIndex((section) => section.id === activeId);
  const chapter = sections[index];
  if (!chapter) return null;
  const next = sections[index + 1];
  const own = new Set(chapter.diffs.map((diff) => diff.file));
  const viewed = [...own].filter((file) => files.views.get(file)?.viewed).length;
  const left = viewed < own.size;
  // Hidden nits count nowhere, as in the files' headers (a nit on an older diff isn't hidden). A comment on a file split
  // across chapters counts in the one with its line.
  const comments = draft?.comments.filter((comment) => own.has(comment.file) && !(draft.hideNits && comment.severity === "nit" && draftState(comment, draft.stale) !== "older-diff") && chapterAt(sections, texts.get(comment.file) ?? "", comment)?.id === chapter.id).length ?? 0;
  const unviewed = next ? [] : [...new Set(sections.flatMap((section) => section.diffs.map((diff) => diff.file)))].filter((file) => !own.has(file) && !files.views.get(file)?.viewed);
  // A closed PR has nothing to finish: the last chapter leads to its archived review instead.
  const closed = review.prState === "MERGED" || review.prState === "CLOSED";
  const button = cn("min-w-0 max-w-full @max-[480px]/review:w-full", TOUCH_CONTROL);
  // The next chapter opens at its top: its title takes the focus, which would stay down here, past its files.
  const goNext = (id: string) => {
    const box = root.current?.parentElement;
    go(id);
    requestAnimationFrame(() => {
      const title = box?.querySelector<HTMLElement>(":scope > section h3");
      if (!title) return;
      if (!title.hasAttribute("tabindex")) title.tabIndex = -1;
      title.focus({ preventScroll: true });
    });
  };
  return (
    <div ref={root} className="mt-6 space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
        <MetaLine className="mr-auto tabular-nums" items={[`${viewed} of ${plural(own.size, "file")} viewed`, comments > 0 && plural(comments, "comment")]} />
        {/* Where the pane is phone-sized, each button takes a row of its own. */}
        <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2 @max-[480px]/review:w-full">
          {left && (
            <Button size="sm" className={button} onClick={() => { files.markChapterViewed(chapter.id); if (next) goNext(next.id); else if (!closed) openFinish(); }}>
              <Icon name="CircleCheck" aria-hidden />
              {next ? "Mark viewed and continue" : closed ? "Mark viewed" : "Mark viewed and finish"}
            </Button>
          )}
          <Button variant={left ? "ghost" : "default"} size="sm" className={cn(button, left && "text-muted-foreground")} onClick={() => next ? goNext(next.id) : openFinish()}>
            <span className="truncate">{next ? <>Next: <InlineCode text={next.title} /></> : closed ? "Archived review" : "Finish review"}</span>
            <Icon name="ArrowRight" aria-hidden />
          </Button>
        </div>
      </div>
      {unviewed.length > 0 && (
        <p className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs text-muted-foreground @max-[480px]/review:justify-start">
          <span className="min-w-0">
            {plural(unviewed.length, "file")} not viewed yet: <span className="font-mono text-[11px] text-foreground/90">{unviewed.slice(0, NAMED).map(basename).join(", ")}</span>
            {unviewed.length > NAMED && <span className="whitespace-nowrap"> and {unviewed.length - NAMED} more</span>}
          </span>
          <Button variant="ghost" size="sm" className={cn("h-7 px-2 text-primary hover:text-primary", TOUCH_CONTROL)} onClick={files.nextUnviewed}>
            Next unviewed<Icon name="ChevronRight" aria-hidden />
          </Button>
        </p>
      )}
    </div>
  );
}
