import { SHORTCUTS } from "../lib/review-shortcuts";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

/** The workspace's keyboard shortcuts, opened with "?". */
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
        <dl className="space-y-2 text-sm">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.label} className="flex items-center gap-3">
              <dt className="flex w-16 shrink-0 gap-1">
                {shortcut.keys.map((key) => <kbd key={key} className="min-w-6 rounded-md border border-border bg-muted px-1.5 text-center font-mono text-xs leading-5 text-foreground">{key}</kbd>)}
              </dt>
              <dd className="text-muted-foreground">{shortcut.label}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
