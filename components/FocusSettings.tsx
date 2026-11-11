import { useState, type ComponentProps } from "react";
import { experimental_ProviderModelPicker as ProviderModelPicker, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import type { AgentExecution, Focus, FocusSettings as Settings } from "../lib/review-preferences";
import { focusInstructions, focusTemplates } from "../lib/focus-templates";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";
import { DISABLED_TEXT } from "./SettingsKnobs";

const TARGET = "min-h-11 min-w-11 h-auto whitespace-normal";

export function focusSettingsProblem(settings: Settings): string | undefined {
  if (settings.focuses.length > 12) return "12 saved focuses maximum";
  if (settings.focuses.filter((focus) => focus.enabled).length > 4) return "4 focuses can run at once";
}

function nameProblem(focus: Focus, focuses: Focus[]): string | undefined {
  if (!/^[\p{L}\p{N} ._-]{1,24}$/u.test(focus.label.trim())) return "Use 1–24 letters, numbers, spaces, dots, underscores or hyphens.";
  if (focuses.some((other) => other.id !== focus.id && other.label.toLowerCase() === focus.label.trim().toLowerCase())) return "Choose a unique name.";
}

/** Edits stage here; the Settings page's explicit Save persists them. */
export function FocusSettings({ value, reviewAgent, disabled, onChange }: { value: Settings; reviewAgent: AgentExecution | null; disabled: boolean; onChange(update: (current: Settings) => Settings): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ focus: Focus; added: boolean } | null>(null);
  const focus = editing?.focus;
  const template = focusTemplates.find((template) => template.id === focus?.template);
  const problem = focus && nameProblem(focus, value.focuses);
  const instructions = focus ? focusInstructions(focus) : "";
  const incomplete = focus?.agent && (!focus.agent.providerId || !focus.agent.model || !focus.agent.reasoningLevel);
  function update(change: (focus: Focus) => Focus) {
    setEditing((current) => current && { ...current, focus: change(current.focus) });
  }
  function add(templateId?: string) {
    if (value.focuses.length >= 12) return;
    const template = focusTemplates.find((template) => template.id === templateId);
    const base = template?.label ?? "New focus";
    let label = base;
    for (let number = 2; value.focuses.some((focus) => focus.label.toLowerCase() === label.toLowerCase()); number++) label = `${base} ${number}`;
    setEditing({ added: true, focus: { id: crypto.randomUUID(), label, enabled: true, agent: null, ...(template ? { template: template.id } : { instructions: "" }) } });
    setAdding(false);
  }
  async function customize() {
    const focusId = focus?.id;
    let agent: NonNullable<Focus["agent"]> = { providerId: "", model: "", reasoningLevel: "medium" };
    try {
      const defaults = reviewAgent ?? (await rpc.call("getAgentDefaults", null)).defaults;
      if (defaults) agent = { providerId: defaults.providerId, model: defaults.model, reasoningLevel: defaults.reasoningLevel, ...(defaults.serviceTier ? { serviceTier: defaults.serviceTier } : {}) };
    } catch { /* The picker resolves the empty seed. */ }
    update((focus) => focus.id !== focusId || focus.agent ? focus : { ...focus, agent });
  }
  return <>
    <fieldset disabled={disabled || !value.enabled} className={`ml-6 min-w-0 space-y-3 text-sm ${value.enabled ? "" : DISABLED_TEXT}`}>
      <p className="flex min-h-11 flex-wrap items-center gap-2"><strong>General</strong><span>The review agent’s own review. Always runs.</span></p>
      {value.focuses.map((focus) => <div key={focus.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border py-2">
        <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5"><input aria-label={`Enable ${focus.label}`} type="checkbox" className="size-4 shrink-0 accent-primary" checked={focus.enabled} onChange={(event) => onChange((current) => ({ ...current, focuses: current.focuses.map((entry) => entry.id === focus.id ? { ...entry, enabled: event.target.checked } : entry) }))} /><strong>{focus.label}</strong></label>
        <span className="min-w-0 basis-full text-muted-foreground sm:order-none sm:basis-auto sm:flex-1">{focusInstructions(focus).split(/(?<=[.!?])\s|\n/)[0]}</span>
        <span className="min-w-0 break-words text-xs text-muted-foreground">{focus.agent ? `${focus.agent.providerId} · ${focus.agent.model} · ${focus.agent.reasoningLevel}` : "Review agent’s model"}</span>
        <Button variant="ghost" size="sm" className={TARGET} aria-label={`Edit ${focus.label}`} onClick={() => setEditing({ focus: { ...focus }, added: false })}>Edit</Button>
      </div>)}
      <Button variant="outline" size="sm" className={TARGET} disabled={value.focuses.length >= 12} aria-expanded={adding} onClick={() => setAdding(!adding)}>Add focus</Button>
      {adding && <div className="flex flex-wrap gap-2">
        {focusTemplates.map((template) => <Button key={template.id} variant="outline" className={TARGET} onClick={() => add(template.id)}>{template.label}</Button>)}
        <Button variant="outline" className={TARGET} onClick={() => add()}>Blank focus</Button>
      </div>}
      {value.focuses.length >= 12 && <p className="text-xs text-muted-foreground">12 saved focuses maximum</p>}
      {focusSettingsProblem(value) && <p role="alert" className="text-xs text-destructive-text">{focusSettingsProblem(value)}</p>}
      <label className="flex flex-wrap items-center gap-2">Check findings at<select aria-label="Check findings at" className="min-h-11 min-w-0 rounded-md border border-border bg-background px-2" value={value.mergeEffort} onChange={(event) => onChange((current) => ({ ...current, mergeEffort: event.target.value as Settings["mergeEffort"] }))}><option value="same">The review agent’s effort</option><option value="high">High</option></select></label>
    </fieldset>
    <Dialog open={!!editing} onOpenChange={(open) => { if (!open) setEditing(null); }}>
      {focus && <DialogContent className="max-h-[90dvh] min-w-0 overflow-y-auto">
        <DialogTitle>Edit focus</DialogTitle>
        <DialogDescription>Changes apply when you save settings.</DialogDescription>
        <label className="space-y-2 text-sm font-medium">Name<Input aria-label="Name" maxLength={24} value={focus.label} aria-invalid={!!problem} onChange={(event) => update((focus) => ({ ...focus, label: event.target.value }))} /><span className="block text-xs font-normal text-muted-foreground">Shown on its comments.</span></label>
        {problem && <p role="alert" className="text-xs text-destructive-text">{problem}</p>}
        <label className="space-y-2 text-sm font-medium">Instructions<Textarea aria-label="Instructions" maxLength={8000} rows={8} value={instructions} onChange={(event) => update((focus) => ({ ...focus, instructions: event.target.value }))} /></label>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{instructions.length.toLocaleString()} of 8,000</span>{template && <Button variant="ghost" size="sm" className={TARGET} onClick={() => update(({ instructions: _edited, ...focus }) => focus)}>Reset to template</Button>}</div>
        {template && <p className="text-xs text-muted-foreground">Based on <a className="inline-flex min-h-11 items-center underline underline-offset-4" href={template.source} target="_blank" rel="noreferrer">{template.holder}</a> ({template.license}), changed. <a className="inline-flex min-h-11 items-center underline underline-offset-4" href="https://github.com/AndrewBird81/bb-plugin-code-review-workspace/blob/main/THIRD_PARTY_NOTICES.md" target="_blank" rel="noreferrer">Licenses ↗</a></p>}
        <div className="space-y-2"><p className="text-sm font-medium">Agent</p><div role="group" aria-label="Focus agent" className="flex flex-wrap gap-2">
          <Button variant="outline" className={TARGET} aria-pressed={!focus.agent} onClick={() => update((focus) => ({ ...focus, agent: null }))}>The review agent’s</Button>
          <Button variant="outline" className={TARGET} aria-pressed={!!focus.agent} onClick={() => void customize()}>Custom</Button>
        </div>
        {focus.agent && <ProviderModelPicker disabled={disabled} routing={reviewAgent?.hostId ? { kind: "host", hostId: reviewAgent.hostId } : undefined} value={{ ...focus.agent, reasoningLevel: focus.agent.reasoningLevel as ComponentProps<typeof ProviderModelPicker>["value"]["reasoningLevel"] }} onChange={(next) => update((focus) => focus.agent ? { ...focus, agent: { providerId: next.providerId, model: next.model, reasoningLevel: next.reasoningLevel, ...(next.serviceTier ? { serviceTier: next.serviceTier } : {}) } } : focus)} />}
        <p className="text-xs text-muted-foreground">It reads the PR at the lowest permissions its provider allows.</p></div>
        <div className="flex flex-wrap items-center gap-2">
          {!editing.added && <Button variant="ghost" className={`${TARGET} mr-auto`} onClick={() => { onChange((current) => ({ ...current, focuses: current.focuses.filter((entry) => entry.id !== focus.id) })); setEditing(null); }}>Remove focus</Button>}
          <Button variant="ghost" className={TARGET} onClick={() => setEditing(null)}>Cancel</Button>
          <Button className={TARGET} disabled={disabled || !!problem || !!incomplete || instructions.length > 8000} onClick={() => {
            const saved = { ...focus, label: focus.label.trim() };
            if (template && saved.instructions === template.instructions) delete saved.instructions;
            onChange((current) => ({ ...current, focuses: editing.added ? [...current.focuses, saved] : current.focuses.map((entry) => entry.id === focus.id ? saved : entry) }));
            setEditing(null);
          }}>Done</Button>
        </div>
      </DialogContent>}
    </Dialog>
  </>;
}
