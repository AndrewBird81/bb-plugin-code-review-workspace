import { useEffect, useRef, useState } from "react";
import { snoozeTimes } from "../lib/turn";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";
import { TOUCH_CONTROL } from "./touch";

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** A row of a menu, such as Review actions: an icon and its label, any hint at the right (ml-auto), and 44px tall on a coarse pointer. */
export const MENU_ITEM = `w-full justify-start text-muted-foreground hover:text-foreground ${TOUCH_CONTROL}`;
const BUSY_ITEM = `${MENU_ITEM} aria-disabled:opacity-50`;

/**
 * The Snooze menu: until the author responds (`onUntilAuthor`, for a review you gave), or until later today, tomorrow
 * morning, Monday morning, or 9 AM on a date you pick (`onPick`). `disabled`: a snooze is running; its choices stay
 * focusable, unavailable, and ignore the click.
 */
export function SnoozeChoices({ onUntilAuthor, onPick, disabled, className }: { onUntilAuthor?: () => void; onPick?: (until: number) => void; disabled?: boolean; className?: string }) {
  const [picking, setPicking] = useState(false);
  const [date, setDate] = useState("");
  const dateBox = useRef<HTMLInputElement>(null);
  const times = snoozeTimes();
  // On a Monday, Monday is a week away.
  const monday = new Date().getDay() === 1 ? "Next Monday" : "Monday";
  const choices = onPick ? [
    times.laterToday && { label: "Later today", hint: time(times.laterToday), until: times.laterToday },
    { label: "Tomorrow", hint: time(times.tomorrow), until: times.tomorrow },
    times.nextMonday !== times.tomorrow && { label: monday, hint: time(times.nextMonday), until: times.nextMonday },
  ].filter((choice) => !!choice) : [];
  const picked = (() => {
    const [y, m, d] = date.split("-").map(Number);
    const until = y && m && d ? new Date(y, m - 1, d, 9).getTime() : NaN;
    return until > Date.now() ? until : null;
  })();
  // The first day whose 9 AM is ahead: today, for a reviewer still up past midnight, or else tomorrow.
  const thisMorning = new Date().setHours(9, 0, 0, 0);
  const first = new Date(thisMorning > Date.now() ? thisMorning : times.tomorrow);
  const min = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}-${String(first.getDate()).padStart(2, "0")}`;
  useEffect(() => {
    if (!picking) return;
    dateBox.current?.focus();
    // The calendar opens at once where the browser can, while the tap that asked for it still counts.
    try { dateBox.current?.showPicker?.(); } catch { /* the box is there to type into or tap */ }
  }, [picking]);
  return (
    <div role="group" aria-label="Snooze" className={className}>
      {onUntilAuthor && <Button variant="ghost" size="sm" aria-disabled={disabled} className={BUSY_ITEM} onClick={() => { if (!disabled) onUntilAuthor(); }}>
        Until the author responds
      </Button>}
      {choices.map((choice) => (
        <Button key={choice.label} variant="ghost" size="sm" aria-disabled={disabled} className={BUSY_ITEM} onClick={() => { if (!disabled) onPick?.(choice.until); }}>
          {choice.label}<span className="sr-only">, </span><span className="ml-auto text-xs font-normal text-subtle-foreground">{choice.hint}</span>
        </Button>
      ))}
      {onPick && (picking
        ? <form className="flex items-center gap-1.5 px-2 pb-1 pt-1" onSubmit={(e) => { e.preventDefault(); if (picked && !disabled) onPick(picked); }}>
          <Input ref={dateBox} type="date" value={date} min={min} onChange={(e) => setDate(e.target.value)} aria-label="Snooze until a date" className={`h-8 min-w-0 flex-1 text-sm ${TOUCH_CONTROL} max-md:pointer-coarse:h-11`} />
          <Button type="submit" variant="outline" size="sm" disabled={!picked} aria-disabled={disabled} className={`${TOUCH_CONTROL} aria-disabled:opacity-50`}>Snooze</Button>
        </form>
        : <Button variant="ghost" size="sm" aria-disabled={disabled} className={BUSY_ITEM} onClick={() => { if (!disabled) setPicking(true); }}>
          Pick a date…<Icon name="Calendar" className="ml-auto text-subtle-foreground" aria-hidden />
        </Button>)}
    </div>
  );
}
