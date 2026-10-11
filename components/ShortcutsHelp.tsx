import { KEY_LABEL, SHORTCUTS } from "../lib/review-shortcuts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

const GROUPS = [...new Set(SHORTCUTS.map((shortcut) => shortcut.group))];

/** The workspace's keyboard shortcuts, opened with "?", grouped by what they're for. */
export function ShortcutsHelp({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* As tall as its list. The dialog is portaled straight into <body>, so a page rule like
          `body > div { height: 100vh }` (the harness's stand-in for BB's base styles has one) made it
          full height, its grid rows spreading an empty band above the list. */}
      <DialogContent className="h-auto max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Work anywhere in the review except while you type.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {GROUPS.map((group) => (
            <section key={group} aria-label={group} className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground">{group}</h3>
              <dl className="space-y-2 text-sm">
                {SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => (
                  <div key={shortcut.label} className="flex items-center gap-3">
                    <dt className="flex w-16 shrink-0 gap-1">
                      {shortcut.keys.map((key) => <kbd key={key} className="min-w-6 rounded-md border border-border bg-muted px-1.5 text-center font-mono text-xs leading-5 text-foreground">{KEY_LABEL[key] ?? key}</kbd>)}
                    </dt>
                    <dd className="text-muted-foreground">{shortcut.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
