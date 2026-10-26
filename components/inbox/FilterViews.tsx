import { useState, type ReactNode } from "react";
import { VIEW_NAME_LIMIT, viewNameProblem, type FilterView } from "../../lib/review-filters";
import { cn } from "../../lib/utils";
import { MENU_ITEM } from "../SnoozeChoices";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
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

/** A button opening a popover of `children`, which `close` shuts. */
function Pop({ label, trigger, title, children }: { label: string; trigger: ReactNode; title: string; children(close: () => void): ReactNode }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild>
      <Button variant="ghost" size="sm" aria-label={label} className={ACTION}>{trigger}</Button>
    </PopoverTrigger>
    <PopoverContent align="start" mobileTitle={title} className="w-64 max-w-[calc(100vw-24px)] p-1">{children(() => setOpen(false))}</PopoverContent>
  </Popover>;
}

/**
 * Your views as tabs, All first, the one the filters started from pressed. Picking one sets its filters; the pressed
 * one's ⋯ renames or deletes it.
 */
export function ViewTabs({ views, active, onPick, onRename, onDelete }: {
  views: readonly FilterView[]; active: FilterView | null; onPick(view: FilterView | null): void; onRename(view: FilterView, name: string): void; onDelete(view: FilterView): void;
}) {
  const tab = (pressed: boolean) => cn("h-7 shrink-0 rounded-md px-2.5 text-xs", TOUCH_CONTROL, pressed ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground");
  return <div role="toolbar" aria-label="Views" className="flex items-center gap-1 overflow-x-auto">
    <Button variant="ghost" size="sm" aria-pressed={!active} className={tab(!active)} onClick={() => onPick(null)}>All</Button>
    {views.map((view) => <div key={view.id} className="flex shrink-0 items-center">
      <Button variant="ghost" size="sm" aria-pressed={view.id === active?.id} className={tab(view.id === active?.id)} onClick={() => onPick(view)}>{view.name}</Button>
      {view.id === active?.id && <Pop label={`${view.name} view actions`} title={view.name} trigger={<Icon name="MoreHorizontal" className="size-3.5" aria-hidden />}>
        {(close) => <ViewActions views={views} view={view} onRename={(name) => { onRename(view, name); close(); }} onDelete={() => { onDelete(view); close(); }} />}
      </Pop>}
    </div>)}
  </div>;
}

function ViewActions({ views, view, onRename, onDelete }: { views: readonly FilterView[]; view: FilterView; onRename(name: string): void; onDelete(): void }) {
  const [renaming, setRenaming] = useState(false);
  if (renaming) return <NameForm views={views} initial={view.name} except={view.id} submit="Rename" onSave={onRename} />;
  return <div role="group" aria-label={`${view.name} view`}>
    <Button variant="ghost" size="sm" className={MENU_ITEM} onClick={() => setRenaming(true)}><Icon name="Edit" aria-hidden />Rename</Button>
    <Button variant="ghost" size="sm" className={cn(MENU_ITEM, "hover:text-destructive-text")} onClick={onDelete}><Icon name="Trash2" aria-hidden />Delete view</Button>
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
