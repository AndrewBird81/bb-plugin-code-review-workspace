import { useState, type ReactNode } from "react";
import { fold } from "../../lib/review-search";
import {
  choicesFor, DAY_CHOICES, daysLabel, FIELD_GROUPS, FIELDS, isDateField, labelColor,
  type DateField, type Filter, type FilterField, type ValueField,
} from "../../lib/review-filters";
import type { ReviewItem } from "../../lib/review-state";
import { cn } from "../../lib/utils";
import { MENU_ITEM } from "../SnoozeChoices";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

const MENU = "w-72 max-w-[calc(100vw-24px)] p-1";
const SEGMENT = "h-7 rounded-none px-2 text-xs font-normal text-muted-foreground hover:text-foreground pointer-coarse:h-11 pointer-coarse:min-w-11";

/** The filter on `field` with `values` set, or none with no values left. */
function withValues(filters: readonly Filter[], field: ValueField, values: string[]): Filter[] {
  const at = filters.findIndex((f) => f.field === field);
  const was = at < 0 ? undefined : filters[at] as Extract<Filter, { values: string[] }>;
  const next: Filter = { field, values, ...(was?.negate ? { negate: true } : {}) };
  if (!values.length) return filters.filter((_, i) => i !== at);
  return at < 0 ? [...filters, next] : filters.map((f, i) => i === at ? next : f);
}

function withDate(filters: readonly Filter[], field: DateField, days: number, before: boolean): Filter[] {
  const next: Filter = { field, days, ...(before ? { before: true } : {}) };
  return filters.some((f) => f.field === field) ? filters.map((f) => f.field === field ? next : f) : [...filters, next];
}

/** A field's choices: its values to tick, each with how many reviews have it, or a date filter's spans. */
function FieldChoices({ field, filters, onFilters, reviews, onDone, onBack }: {
  field: FilterField; filters: readonly Filter[]; onFilters(filters: Filter[]): void; reviews: readonly ReviewItem[]; onDone(): void; onBack?: () => void;
}) {
  const [query, setQuery] = useState("");
  const info = FIELDS.get(field)!;
  const back = onBack && <Button variant="ghost" size="sm" className={MENU_ITEM} onClick={onBack}><Icon name="ChevronLeft" aria-hidden />{info.title}</Button>;
  if (isDateField(field)) {
    const pick = (days: number, before: boolean) => { onFilters(withDate(filters, field, days, before)); onDone(); };
    const current = filters.find((f) => f.field === field) as Extract<Filter, { days: number }> | undefined;
    return <div role="group" aria-label={info.title}>
      {back}
      {([false, true] as const).map((before) => <div key={String(before)} role="group" aria-label={before ? "More than" : "In the last"}>
        <p className="px-2.5 pb-0.5 pt-1.5 text-xs text-subtle-foreground">{before ? "More than … ago" : "In the last …"}</p>
        {DAY_CHOICES.map(({ days, label }) => {
          const picked = current?.days === days && !!current.before === before;
          return <Button key={days} variant="ghost" size="sm" aria-pressed={picked} className={MENU_ITEM} onClick={() => pick(days, before)}>
            {label}{picked && <Icon name="Check" className="ml-auto text-primary" aria-hidden />}
          </Button>;
        })}
      </div>)}
    </div>;
  }
  const chosen = (filters.find((f) => f.field === field) as Extract<Filter, { values: string[] }> | undefined)?.values ?? [];
  const needle = fold(query.trim());
  // A value ticked that no review has now, as an author whose reviews went, stays to untick.
  const counted = choicesFor(reviews, field);
  const choices = [...counted, ...chosen.filter((value) => !counted.some((c) => c.value === value)).map((value) => ({ value, count: 0 }))]
    .filter(({ value }) => !needle || fold(value).includes(needle));
  const toggle = (value: string) => onFilters(withValues(filters, field, chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value]));
  return <div role="group" aria-label={info.title}>
    {back}
    <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} aria-label={`Find ${info.noun}`} placeholder={`Find ${info.noun}…`}
      onKeyDown={(event) => { if (event.key === "Enter" && choices[0]) { event.preventDefault(); toggle(choices[0].value); } }}
      className="mb-1 h-8 border-0 bg-transparent text-sm shadow-none focus-visible:ring-0 pointer-coarse:h-11" />
    <div className="max-h-72 overflow-y-auto">
      {choices.length ? choices.map(({ value, count }) => {
        const color = field === "labels" ? labelColor(reviews, value) : null;
        return <Button key={value} variant="ghost" size="sm" role="checkbox" aria-checked={chosen.includes(value)} className={MENU_ITEM} onClick={() => toggle(value)}>
          <span className={cn("grid size-4 shrink-0 place-items-center rounded-sm border", chosen.includes(value) ? "border-primary bg-primary text-primary-foreground" : "border-input")}>
            {chosen.includes(value) && <Icon name="Check" className="size-3" aria-hidden />}
          </span>
          {color && <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />}
          <span className="min-w-0 truncate text-foreground">{value}</span>
          <span className="ml-auto text-xs font-normal text-subtle-foreground">{count}</span>
        </Button>;
      }) : <p className="px-2.5 py-2 text-sm text-muted-foreground">{query ? `No ${info.noun} match` : `No reviews have ${info.noun} yet`}</p>}
    </div>
  </div>;
}

/** The Add filter menu: the fields, found by name, then the chosen one's choices. */
function AddFilterMenu({ filters, onFilters, reviews, onDone }: { filters: readonly Filter[]; onFilters(filters: Filter[]): void; reviews: readonly ReviewItem[]; onDone(): void }) {
  const [field, setField] = useState<FilterField | null>(null);
  const [query, setQuery] = useState("");
  if (field) return <FieldChoices field={field} filters={filters} onFilters={onFilters} reviews={reviews} onDone={onDone} onBack={() => setField(null)} />;
  const needle = fold(query.trim());
  const groups = FIELD_GROUPS.map((group) => group.filter((info) => !needle || fold(info.title).includes(needle))).filter((group) => group.length);
  return <div role="group" aria-label="Add filter">
    <Input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Find a filter" placeholder="Add filter…"
      onKeyDown={(event) => { const first = groups[0]?.[0]; if (event.key === "Enter" && first) { event.preventDefault(); setField(first.field); } }}
      className="mb-1 h-8 border-0 bg-transparent text-sm shadow-none focus-visible:ring-0 pointer-coarse:h-11" />
    {groups.map((group, i) => <div key={i} className={cn(i > 0 && "mt-1 border-t border-border pt-1")}>
      {group.map((info) => <Button key={info.field} variant="ghost" size="sm" className={MENU_ITEM} onClick={() => { setField(info.field); setQuery(""); }}>
        <Icon name={info.icon} aria-hidden />{info.title}<Icon name="ChevronRight" className="ml-auto text-subtle-foreground" aria-hidden />
      </Button>)}
    </div>)}
    {!groups.length && <p className="px-2.5 py-2 text-sm text-muted-foreground">No filters match</p>}
  </div>;
}

function Chip({ filter, filters, onFilters, reviews }: { filter: Filter; filters: readonly Filter[]; onFilters(filters: Filter[]): void; reviews: readonly ReviewItem[] }) {
  const [open, setOpen] = useState(false);
  const info = FIELDS.get(filter.field)!;
  const replace = (next: Filter) => onFilters(filters.map((f) => f === filter ? next : f));
  let operator: string, flipped: string, value: ReactNode;
  if ("days" in filter) {
    [operator, flipped] = filter.before ? ["more than", "in the last"] : ["in the last", "more than"];
    value = filter.before ? `${daysLabel(filter.days)} ago` : daysLabel(filter.days);
  } else {
    const many = filter.values.length > 1;
    const words = (negate: boolean) => negate ? (many ? "is none of" : "is not") : (many ? "is any of" : "is");
    [operator, flipped] = [words(!!filter.negate), words(!filter.negate)];
    const color = filter.field === "labels" && !many ? labelColor(reviews, filter.values[0] ?? "") : null;
    value = many ? `${filter.values.length} ${info.noun}` : <>{color && <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden />}{filter.values[0]}</>;
  }
  const flip = () => replace("days" in filter ? { ...filter, before: !filter.before } : { ...filter, negate: !filter.negate });
  return <li className="flex h-7 items-stretch overflow-hidden rounded-md border border-border bg-surface-raised text-xs shadow-xs pointer-coarse:h-11">
    <span className="flex items-center gap-1.5 px-2 text-foreground"><Icon name={info.icon} className="size-3.5" aria-hidden />{info.title}</span>
    <Button variant="ghost" size="sm" className={cn(SEGMENT, "border-l border-border")} aria-label={`${info.title} ${operator}; switch to ${flipped}`} onClick={flip}>{operator}</Button>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className={cn(SEGMENT, "gap-1.5 border-l border-border text-foreground")}>{value}</Button>
      </PopoverTrigger>
      <PopoverContent align="start" mobileTitle={info.title} className={MENU}>
        <FieldChoices field={filter.field} filters={filters} onFilters={onFilters} reviews={reviews} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
    <Button variant="ghost" size="sm" className={cn(SEGMENT, "border-l border-border px-1.5")} aria-label={`Remove ${info.title} filter`} onClick={() => onFilters(filters.filter((f) => f !== filter))}>
      <Icon name="X" className="size-3.5" aria-hidden />
    </Button>
  </li>;
}

/**
 * The list's filters as chips, each saying its field, how it matches (a click flips it: is / is not, in the last / more
 * than), and its values, which open to change; then Filter, or + once there's one, to add another. `menuOpen` lets F open it.
 */
export function FilterBar({ filters, onFilters, reviews, menuOpen, onMenuOpen }: {
  filters: readonly Filter[]; onFilters(filters: Filter[]): void; reviews: readonly ReviewItem[]; menuOpen: boolean; onMenuOpen(open: boolean): void;
}) {
  return <ul aria-label="Filters" className="flex flex-wrap items-center gap-1.5">
    {filters.map((filter) => <Chip key={filter.field} filter={filter} filters={filters} onFilters={onFilters} reviews={reviews} />)}
    <li>
      <Popover open={menuOpen} onOpenChange={onMenuOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="Add filter" className={cn("h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground", TOUCH_CONTROL)}>
            <Icon name={filters.length ? "Plus" : "SlidersHorizontal"} className="size-3.5" aria-hidden />{!filters.length && "Filter"}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" mobileTitle="Add filter" className={MENU}>
          <AddFilterMenu filters={filters} onFilters={onFilters} reviews={reviews} onDone={() => onMenuOpen(false)} />
        </PopoverContent>
      </Popover>
    </li>
    {filters.length > 1 && <li><Button variant="ghost" size="sm" className={cn("h-7 px-2 text-xs text-muted-foreground hover:text-foreground", TOUCH_CONTROL)} onClick={() => onFilters([])}>Clear</Button></li>}
  </ul>;
}
