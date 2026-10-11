import { cn } from "../../lib/utils";
import { useWorkspace } from "../../lib/workspace-context";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { DraftPanel } from "../DraftPanel";
import { FeedbackPanel } from "../FeedbackPanel";
import { ReviewerNotes } from "../ReviewerNotes";
import { ThreadsPanel } from "../ThreadsPanel";

/** Comments' parts until they're one list: your draft, your feedback since your review, and the PR's GitHub threads. */
export type CommentsTab = "drafts" | "feedback" | "threads";
const TABS = [
  { id: "drafts", label: "Drafts", icon: "EditFile" },
  { id: "feedback", label: "Feedback", icon: "ChatFeedback" },
  { id: "threads", label: "Threads", icon: "MessageSquare" },
] as const;

/**
 * The side panel's Comments, and its Finish review (`finish`): the same draft, which Finish shows alone, at its summary
 * and Submit, with your private notes. A local review has only its draft. Hidden, it stays mounted, as the draft must.
 */
export function CommentsView({ shown, finish, tab, onTab, revision, onShowThread }: {
  shown: boolean;
  finish: boolean;
  tab: CommentsTab;
  onTab: (tab: CommentsTab) => void;
  /** The review revision the page shows, for draft changes from Feedback. */
  revision: string;
  /** Show a GitHub thread's line, with the threads showing in the code. */
  onShowThread: (file: string, line: number | null, side: "LEFT" | "RIGHT", url?: string | null) => void;
}) {
  const { review, targetKey, followUp, openFinish } = useWorkspace();
  const isPr = review.kind === "pr";
  const current: CommentsTab = finish || !isPr ? "drafts" : tab;
  return (
    <div hidden={!shown} className={cn("flex min-h-0 flex-1 flex-col", !shown && "hidden")}>
      {isPr && !finish && (
        <div role="group" aria-label="Comments" className="flex shrink-0 gap-0.5 border-b border-border px-3 py-2">
          <div className="inline-flex gap-0.5 rounded-lg bg-muted/40 p-0.5 ring-1 ring-inset ring-border">
            {TABS.map((item) => (
              <Button key={item.id} variant="ghost" size="sm" aria-pressed={current === item.id} className={cn("h-7 gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground aria-pressed:shadow-xs", TOUCH_CONTROL)} onClick={() => onTab(item.id)}>
                <Icon name={item.icon} className="size-3.5" aria-hidden />{item.label}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div hidden={current !== "drafts"} className={cn("flex min-h-0 flex-1 flex-col", current !== "drafts" && "hidden")}>
        <DraftPanel>
          {/* Only Finish shows them; hidden elsewhere, they stay mounted, as every view does, keeping what you write. */}
          <details hidden={!finish} className={cn("group/notes rounded-lg border border-border", !finish && "hidden")}>
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
              <Icon name="Lock" className="size-3.5 text-subtle-foreground" aria-hidden />Private notes
              <Icon name="ChevronDown" className="ml-auto size-3.5 text-subtle-foreground transition-transform duration-150 group-open/notes:rotate-180" aria-hidden />
            </summary>
            <div className="border-t border-border"><ReviewerNotes targetKey={targetKey} /></div>
          </details>
        </DraftPanel>
      </div>
      {current === "feedback" && <div className="min-h-0 flex-1 overflow-y-auto p-3"><FeedbackPanel targetKey={targetKey} review={review} revision={revision} onShowLocation={onShowThread} onFollowUp={followUp} onDraftUpdated={openFinish} /></div>}
      {current === "threads" && <div className="min-h-0 flex-1 overflow-y-auto p-3"><ThreadsPanel targetKey={targetKey} onShowInDiff={onShowThread} /></div>}
    </div>
  );
}
