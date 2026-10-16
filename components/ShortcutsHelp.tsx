import { COMMENT_BOX_KEYS, KEY_LABEL, SHORTCUTS } from "../lib/review-shortcuts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

const GROUPS = [...new Set(SHORTCUTS.map((shortcut) => shortcut.group))];

/** One group of keys, each row its keys then what they do. */
function KeyGroup({ title, rows }: { title: string; rows: ReadonlyArray<{ keys: readonly string[]; label: string }> }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">{title}</h3>
      <dl className="space-y-2 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3">
            <dt className="flex min-w-16 shrink-0 gap-1">
              {row.keys.map((key) => <kbd key={key} className="min-w-6 rounded-md border border-border bg-muted px-1.5 text-center font-mono text-xs leading-5 text-foreground">{KEY_LABEL[key] ?? key}</kbd>)}
            </dt>
            <dd className="text-muted-foreground">{row.label}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The workspace's keyboard shortcuts, opened with "?", grouped by what they're for. */
export function ShortcutsHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  // Closing, it fades out with the focus still in it, outside the review, whose keys would wait until it's gone.
  const change = (next: boolean) => {
    if (!next) (document.activeElement as HTMLElement | null)?.blur();
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={change}>
      {/* As tall as its list. The dialog is portaled straight into <body>, so a page rule like
          `body > div { height: 100vh }` (the harness's stand-in for BB's base styles has one) made it
          full height, its grid rows spreading an empty band above the list. */}
      <DialogContent className="h-auto max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Work anywhere in the review except while you type.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {GROUPS.map((group) => <KeyGroup key={group} title={group} rows={SHORTCUTS.filter((shortcut) => shortcut.group === group)} />)}
          <KeyGroup title="In a comment box" rows={COMMENT_BOX_KEYS} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
