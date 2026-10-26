import { useState, type ReactNode } from "react";
import { VIEW_NAME_LIMIT, viewNameProblem, type FilterView } from "../../lib/review-filters";
import { cn } from "../../lib/utils";
import { TOUCH_CONTROL, TOUCH_TARGET } from "../touch";
import { Button } from "../ui/button";
import { Hint } from "../ui/hint";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

const ACTION = cn("h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground", TOUCH_CONTROL);

/** A view's name to type, checked against the others' as you go; Enter or the button saves it. */
function NameForm({ views, initial = "", except, submit, onSave }: { views: readonly FilterView[]; initial?: string; except?: string; submit: string; onSave(name: string): void }) {
  const [name, setName] = useState(initial);
  const [tried, setTried] = useState(false);
  const problem = viewNameProblem(views, name, except);
  return <form className="space-y-2 p-1.5" onSubmit={(event) => { event.preventDefault(); setTried(true); if (!problem) onSave(name.trim()); }}>
    <Input autoFocus value={name} maxLength={VIEW_NAME_LIMIT} onChange={(event) => setName(event.target.value)} aria-label="View name" placeholder="View name"
      aria-invalid={tried && !!problem} className={cn("h-8 text-sm", TOUCH_CONTROL)} />
    {tried && problem && <p role="alert" className="text-xs text-destructive-text">{problem}</p>}
    <Button type="submit" size="sm" className={cn("w-full", TOUCH_CONTROL)}>{submit}</Button>
  </form>;
}

/** A button opening a popover of `children`, which `close` shuts; `hint` names an icon-only one on hover. */
function Pop({ label, trigger, title, hint, className = ACTION, children }: { label: string; trigger: ReactNode; title: string; hint?: string; className?: string; children(close: () => void): ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = <PopoverTrigger asChild>
    <Button variant="ghost" size="sm" aria-label={label} className={className}>{trigger}</Button>
  </PopoverTrigger>;
  return <Popover open={open} onOpenChange={setOpen}>
    {hint ? <Hint label={hint}>{button}</Hint> : button}
    <PopoverContent align="start" mobileTitle={title} className="w-64 max-w-[calc(100vw-24px)] p-1">{children(() => setOpen(false))}</PopoverContent>
  </Popover>;
}

/**
 * Your views as tabs, All first, the one the filters started from pressed. Picking one sets its filters; the pressed
 * one holds a pencil to rename it, and an x on its top-left corner deletes it. A deleted view's filters stay set, so
 * Save view brings it back.
 */
export function ViewTabs({ views, active, onPick, onRename, onDelete }: {
  views: readonly FilterView[]; active: FilterView | null; onPick(view: FilterView | null): void; onRename(view: FilterView, name: string): void; onDelete(view: FilterView): void;
}) {
  const tab = (pressed: boolean) => cn("h-7 shrink-0 rounded-md px-2.5 text-xs", TOUCH_CONTROL, pressed ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground");
  // Room above and before the tabs for the pressed one's x, which the row's scrolling would clip.
  return <div role="toolbar" aria-label="Views" className="flex items-center gap-1 overflow-x-auto pl-1.5 pt-1.5">
    <Button variant="ghost" size="sm" aria-pressed={!active} className={tab(!active)} onClick={() => onPick(null)}>All</Button>
    {views.map((view) => view.id !== active?.id
      ? <Button key={view.id} variant="ghost" size="sm" aria-pressed={false} className={tab(false)} onClick={() => onPick(view)}>{view.name}</Button>
      : <div key={view.id} className="relative flex shrink-0 items-center rounded-md bg-accent">
        <Button variant="ghost" size="sm" aria-pressed className={cn("h-7 rounded-md pl-2.5 pr-1 text-xs text-foreground hover:bg-transparent", TOUCH_CONTROL)} onClick={() => onPick(view)}>{view.name}</Button>
        <Pop label={`Rename ${view.name}`} hint="Rename view" title="Rename view" trigger={<Icon name="Edit" className="size-3" aria-hidden />}
          className={cn("h-7 rounded-md px-1.5 text-muted-foreground hover:bg-transparent hover:text-foreground", TOUCH_CONTROL)}>
          {(close) => <NameForm views={views} initial={view.name} except={view.id} submit="Rename" onSave={(name) => { onRename(view, name); close(); }} />}
        </Pop>
        <Hint label="Delete view">
          <button type="button" aria-label={`Delete ${view.name}`} onClick={() => onDelete(view)}
            className={cn("absolute -left-1.5 -top-1.5 grid size-4 place-items-center rounded-full border border-border bg-popover text-muted-foreground shadow-xs hover:text-destructive-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", TOUCH_TARGET)}>
            <Icon name="X" className="size-2.5" aria-hidden />
          </button>
        </Hint>
      </div>)}
  </div>;
}

/**
 * Keep the filters as a view: Save view names a new one; once a view's filters change, Save updates it and Save as new
 * names another.
 */
export function SaveView({ views, active, changed, hasFilters, onCreate, onUpdate }: {
  views: readonly FilterView[]; active: FilterView | null; changed: boolean; hasFilters: boolean; onCreate(name: string): void; onUpdate(): void;
}) {
  const saveNew = (label: string) => <Pop label={label} title={label} trigger={<><Icon name="Pin" className="size-3.5" aria-hidden />{label}</>}>
    {(close) => <NameForm views={views} submit="Save view" onSave={(name) => { onCreate(name); close(); }} />}
  </Pop>;
  if (!active) return hasFilters ? saveNew("Save view") : null;
  if (!changed) return null;
  return <>
    <Button variant="ghost" size="sm" className={ACTION} onClick={onUpdate}><Icon name="Check" className="size-3.5" aria-hidden />Save</Button>
    {saveNew("Save as new")}
  </>;
}
