/** A chapter's number in a ring that fills as its files are viewed, as the chapters list marks the open one. */
export function ChapterStep({ index, viewed, total }: { index: number; viewed: number; total: number }) {
  return (
    <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full" style={{ background: `conic-gradient(var(--success) ${total ? viewed / total * 360 : 0}deg, var(--border) 0deg)` }}>
      <span className="flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-semibold tabular-nums text-primary-foreground">{index + 1}</span>
    </span>
  );
}
