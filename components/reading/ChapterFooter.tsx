import { useWorkspace } from "../../lib/workspace-context";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { InlineCode } from "../ui/inline-code";

/** The end of a chapter: on to the next, marking this one viewed if you like. After the last, what's next is finishing. */
export function ChapterFooter() {
  const { sections, activeId, files, go, openFinish, review } = useWorkspace();
  const index = sections.findIndex((section) => section.id === activeId);
  const chapter = sections[index];
  if (!chapter) return null;
  const next = sections[index + 1];
  const viewed = chapter.diffs.filter((diff) => files.views.get(diff.file)?.viewed).length;
  const left = viewed < chapter.diffs.length;
  return (
    <div className="mt-6 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
      {left && (
        <Button variant="outline" size="sm" onClick={() => { files.markChapterViewed(chapter.id); if (next) go(next.id); else openFinish(); }}>
          <Icon name="CircleCheck" className="size-3.5" aria-hidden />
          {next ? "Mark chapter viewed and continue" : "Mark chapter viewed and finish"}
        </Button>
      )}
      <Button variant={left ? "ghost" : "soft"} size="sm" className="min-w-0 max-w-full" onClick={() => next ? go(next.id) : openFinish()}>
        <span className="truncate">{next ? <>Next: <InlineCode text={next.title} /></> : review.kind === "pr" ? "Done: Submit review" : "Done: Finish review"}</span>
        <Icon name="ArrowRight" className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}
