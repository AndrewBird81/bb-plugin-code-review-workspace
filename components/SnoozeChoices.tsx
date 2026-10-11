import { useId, useState } from "react";
import { snoozeTimes } from "../lib/turn";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "Snooze until": later today, tomorrow morning, next Monday, or 9 AM on a date. */
export function SnoozeChoices({ onPick, disabled }: { onPick: (until: number) => void; disabled?: boolean }) {
  const [date, setDate] = useState("");
  const headingId = useId();
  const times = snoozeTimes();
  const day = (t: number) => new Date(t).toLocaleDateString([], { weekday: "short" });
  const choices = [
    times.laterToday && { label: "Later today", hint: time(times.laterToday), until: times.laterToday },
    { label: "Tomorrow morning", hint: `${day(times.tomorrow)} ${time(times.tomorrow)}`, until: times.tomorrow },
    { label: "Next Monday", hint: `${new Date(times.nextMonday).toLocaleDateString([], { month: "short", day: "numeric" })} ${time(times.nextMonday)}`, until: times.nextMonday },
  ].filter((choice) => !!choice);
  const picked = (() => {
    const [y, m, d] = date.split("-").map(Number);
    const until = y && m && d ? new Date(y, m - 1, d, 9).getTime() : NaN;
    return until > Date.now() ? until : null;
  })();
  const tomorrow = new Date(times.tomorrow);
  const min = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  return (
    <div role="group" aria-labelledby={headingId}>
      <p id={headingId} className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">Snooze until</p>
      {choices.map((choice) => (
        <Button key={choice.label} variant="ghost" size="sm" disabled={disabled} className="w-full justify-between text-muted-foreground hover:text-foreground" onClick={() => onPick(choice.until)}>
          {choice.label}<span className="text-xs text-subtle-foreground">{choice.hint}</span>
        </Button>
      ))}
      <form className="flex items-center gap-1.5 px-2 pb-1 pt-1" onSubmit={(e) => { e.preventDefault(); if (picked) onPick(picked); }}>
        <Input type="date" value={date} min={min} onChange={(e) => setDate(e.target.value)} aria-label="Snooze until a date" className="h-8 min-w-0 flex-1 text-sm" />
        <Button type="submit" variant="outline" size="sm" disabled={disabled || !picked}>Snooze</Button>
      </form>
    </div>
  );
}
