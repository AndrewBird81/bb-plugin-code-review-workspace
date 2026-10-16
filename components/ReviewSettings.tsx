import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { UrlLink, useRpc, useRealtime, useBbNavigate, experimental_PermissionModePicker as PermissionModePicker, experimental_ProviderModelPicker as ProviderModelPicker } from "@get-bb/plugin-sdk/app";
import type { PluginRpcResult } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import type { PreferencesRecord } from "../src/preferences";
import type { Machine } from "../src/machines";
import { ASSISTANT_INSTRUCTIONS_LIMIT, defaultPreferences, type AgentExecution } from "../lib/review-preferences";
import { defaultKnobs, type KnobId, type Knobs } from "../lib/knobs";
import { withDefaults } from "../lib/settings";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { useReviewSession } from "../lib/review-session";
import { ReleaseSettings, SetupReadiness } from "./ReleaseSettings";
import { Icon, type IconName } from "./ui/icon";
import { IconTile } from "./ui/icon-tile";
import type { Tone } from "./ui/badge";
import { AccountBar } from "./AccountBar";
import { PageBar } from "./PageBar";
import { DISABLED_TEXT, KnobControl, enabledNumberText, type KnobNumberText } from "./SettingsKnobs";
import { TOUCH_CONTROL, TOUCH_TARGET } from "./touch";

/** An aria-disabled primary button, drawn as a disabled one (ui/button). */
const UNAVAILABLE = "aria-disabled:pointer-events-none aria-disabled:bg-muted/60 aria-disabled:text-subtle-foreground aria-disabled:shadow-none";

/** One of a setting's choices, pressed when it's chosen: a long one wraps on a narrow screen, and it's 44px on touch. */
const CHOICE = `h-auto min-h-8 whitespace-normal py-1.5 text-left aria-pressed:border-primary/50 aria-pressed:bg-primary/10 aria-pressed:text-primary pointer-coarse:min-h-11`;

type AgentUpdate = (agent: AgentExecution | null) => AgentExecution | null;
/** undefined while loading; null when they couldn't be loaded. */
type Machines = readonly Machine[] | null | undefined;

/** The bb server is the default machine, stored as no machine so the choice follows a server move. */
function MachineSelect({ hostId, machines, disabled, onChange }: {
  hostId?: string; machines: Machines; disabled: boolean; onChange(hostId: string | undefined): void;
}) {
  const server = machines?.find((machine) => machine.server);
  const others = machines?.filter((machine) => !machine.server) ?? [];
  const value = hostId && hostId !== server?.hostId ? hostId : "";
  return <label className="flex min-w-0 items-center gap-2 text-sm">
    <span className="text-muted-foreground">Machine</span>
    <select aria-label="Machine" disabled={disabled} value={value} onChange={(event) => onChange(event.target.value || undefined)} className="h-8 min-w-0 rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:h-11">
      <option value="">{server ? `${server.name} (server)` : "bb server"}</option>
      {others.map((machine) => <option key={machine.hostId} value={machine.hostId}>{machine.connected ? machine.name : `${machine.name} (offline)`}</option>)}
      {value && !others.some((machine) => machine.hostId === value) && <option value={value}>{machines ? "Removed machine" : value}</option>}
    </select>
  </label>;
}

type ProviderModes = PluginRpcResult<typeof rpcContract["getProviderModes"]>["providers"];

/** Names as a sentence lists them: "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? "";
}

/** Whether an agent on the provider can run below Full. */
function restrictable(provider: ProviderModes[number]): boolean {
  return provider.permissionModes.some((mode) => mode === "accept-edits" || mode === "auto");
}

/**
 * Why an agent on `providerId` can't be restricted, and which of its machine's providers can. None when the provider
 * runs in Accept Edits or Auto, or isn't listed.
 */
function unrestrictedNote(providers: ProviderModes, providerId: string | undefined): string | undefined {
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider || restrictable(provider)) return undefined;
  const restricted = providers.filter((candidate) => candidate.permissionModes.includes("accept-edits")).map((candidate) => candidate.name).sort((a, b) => a.localeCompare(b));
  const alternatives = restricted.length ? ` ${listNames(restricted)} ${restricted.length === 1 ? "runs" : "run"} at Accept Edits.` : "";
  return `${provider.name} runs only at Full, so this agent can’t be restricted.${alternatives}`;
}

function AgentSelection({ label, agent, machines, disabled, note, unrestricted, defaults = "the agent, model, effort, and permissions bb remembers for the project the review runs in", onCustomize, onChange }: {
  label: string; agent: AgentExecution | null; machines: Machines; disabled: boolean; note?: string;
  /** Why this agent can't be restricted (unrestrictedNote). */
  unrestricted?: string;
  /** What Project defaults runs with. */
  defaults?: string;
  onCustomize(): void; onChange(update: AgentUpdate): void;
}) {
  // The pickers list the providers, models, and permission limit of the chosen machine.
  const routing = agent?.hostId ? { kind: "host" as const, hostId: agent.hostId } : undefined;
  return <div className="space-y-2">
    <p className="text-sm font-medium">Agent</p>
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" className={CHOICE} aria-pressed={!agent} onClick={() => onChange(() => null)}>Project defaults</Button>
      <Button variant="outline" size="sm" className={CHOICE} aria-pressed={!!agent} onClick={() => { if (!agent) onCustomize(); }}>Custom</Button>
    </div>
    {agent ? <div className="flex flex-wrap items-center gap-2">
      <MachineSelect hostId={agent.hostId} machines={machines} disabled={disabled} onChange={(hostId) => onChange((current) => {
        if (!current) return current;
        const { hostId: _previous, ...selection } = current;
        return hostId ? { hostId, ...selection } : selection;
      })} />
      <ProviderModelPicker disabled={disabled} routing={routing}
        // The SDK's types list the reasoning levels it knew; a provider's own passes through (lib/review-preferences.ts).
        value={{ providerId: agent.providerId, model: agent.model, reasoningLevel: agent.reasoningLevel as ComponentProps<typeof ProviderModelPicker>["value"]["reasoningLevel"], ...(agent.serviceTier ? { serviceTier: agent.serviceTier } : {}) }}
        onChange={(next) => onChange((current) => current && { ...(current.hostId ? { hostId: current.hostId } : {}), providerId: next.providerId, model: next.model, reasoningLevel: next.reasoningLevel, permissionMode: current.permissionMode, ...(next.serviceTier ? { serviceTier: next.serviceTier } : {}) })} />
      <PermissionModePicker disabled={disabled} routing={routing} providerId={agent.providerId} value={agent.permissionMode} onChange={(permissionMode) => onChange((current) => current && { ...current, permissionMode })} />
    </div> : <p className="text-xs text-muted-foreground">Runs on the bb server with {defaults}.</p>}
    {agent && machines === null && <p className="text-xs text-muted-foreground">Couldn’t load your machines. Reload this page to choose another machine.</p>}
    {unrestricted && <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Icon name="AlertCircle" className="mt-px size-3.5 shrink-0" aria-hidden />{unrestricted}</p>}
    {note && <p className="text-xs text-muted-foreground">{note}</p>}
  </div>;
}

/** One repository pattern per line, as saved: trimmed, lowercase, no blanks. */
function parseRepoPatterns(text: string): string[] {
  return text.split("\n").map((line) => line.trim().toLowerCase()).filter(Boolean);
}

/** Keeps the typed text, blank lines included, while the saved list follows it. */
function RepoPatterns({ value, onChange }: { value: string[]; onChange(value: string[]): void }) {
  const [text, setText] = useState(value.join("\n"));
  // Follow loads, discards, and restored defaults.
  if (parseRepoPatterns(text).join("\n") !== value.join("\n")) setText(value.join("\n"));
  return <Textarea aria-label="Start guides automatically" aria-describedby="auto-start-help" rows={3} value={text} placeholder={"acme/app\nacme/*"} className="font-mono text-xs" onChange={(event) => { setText(event.target.value); onChange(parseRepoPatterns(event.target.value)); }} />;
}

type AgentLearning = PluginRpcResult<typeof rpcContract["getAgentLearning"]>;

/** How the agent's comments fared in your submitted reviews, and its proposal for your instructions, which only Save applies. */
function AgentCommentLearning({ instructions, onAdd }: { instructions: string; onAdd(lines: string): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [learning, setLearning] = useState<AgentLearning | null>(null);
  const [proposal, setProposal] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [nothing, setNothing] = useState(false);
  // A run's result shows once the run is seen. A proposal that finished while you were away opens with Settings,
  // and the server keeps it until you add or discard it.
  const waiting = useRef(false);
  const opened = useRef(false);
  const load = useCallback(async () => {
    const next = await rpc.call("getAgentLearning", null).catch(() => null);
    if (!next) return;
    setLearning(next);
    const { suggestion } = next;
    const opening = !opened.current;
    opened.current = true;
    if (suggestion.state === "running") waiting.current = true;
    else if (waiting.current) {
      waiting.current = false;
      if (suggestion.state === "ready" && suggestion.text) setProposal(suggestion.text);
      if (suggestion.state === "ready" && !suggestion.text) setNothing(true);
      if (suggestion.state === "failed") setError(suggestion.error ?? "The agent couldn’t suggest changes. Try again.");
    } else if (opening && suggestion.state === "ready" && suggestion.text) setProposal(suggestion.text);
  }, [rpc]);
  function settle() {
    setProposal(null);
    void rpc.call("dismissInstructionSuggestion", null).catch(() => {});
  }
  useEffect(() => { void load(); }, [load]);
  useRealtime("learning", () => { void load(); });
  async function suggest() {
    setError(""); setProposal(null); setNothing(false);
    const result = await rpc.call("suggestAssistantInstructions", null).catch(() => ({ ok: false, error: "Couldn’t ask the agent. Try again." }));
    if (result.ok) waiting.current = true;
    else setError(result.error ?? "Couldn’t ask the agent. Try again.");
    await load();
  }
  if (!learning) return null;
  const { total, kept, edited, removed } = learning;
  const running = learning.suggestion.state === "running";
  const combined = [instructions.trim(), proposal?.trim() ?? ""].filter(Boolean).join("\n");
  const fits = combined.length <= ASSISTANT_INSTRUCTIONS_LIMIT;
  return <div className="space-y-2">
    <p className="text-sm font-medium">The agent’s comments</p>
    <p className="text-sm text-muted-foreground">{total ? `Of the agent’s last ${total} comment${total === 1 ? "" : "s"} you kept ${kept} as written, edited ${edited}, removed ${removed}.` : "When you submit reviews, this counts the agent’s comments you kept as written, edited, and removed."}</p>
    {learning.recentRemoved.length > 0 && <div className="space-y-1"><p className="text-xs text-muted-foreground">Recently removed</p><ul className="space-y-1 text-sm">
      {learning.recentRemoved.map((comment, index) => <li key={index} className="flex min-w-0 items-baseline gap-2"><span className="shrink-0 font-mono text-xs text-muted-foreground">{comment.repo ? `${comment.repo} · ${comment.file}` : comment.file}</span><span className="min-w-0 truncate">{comment.line}</span></li>)}
    </ul></div>}
    <Button variant="outline" size="sm" className={TOUCH_CONTROL} disabled={!learning.canSuggest || running} onClick={() => void suggest()}><Icon name="Sparkles" className="size-4" aria-hidden />{running ? "Suggesting…" : "Suggest instruction changes"}</Button>
    <span className="block text-xs text-muted-foreground">Sends your recently removed and edited comments to the review agent, which proposes up to five lines for your instructions. Nothing changes until you add them and save.</span>
    {error && <p role="alert" className="text-xs text-destructive-text">{error}</p>}
    {nothing && <p role="status" className="text-xs text-muted-foreground">The agent found nothing to add.</p>}
    {proposal !== null && <div className="space-y-2 rounded-lg border border-border p-3">
      <Textarea aria-label="Suggested instructions" rows={5} value={proposal} onChange={(event) => setProposal(event.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className={TOUCH_CONTROL} disabled={!proposal.trim() || !fits} onClick={() => { onAdd(proposal.trim()); settle(); }}>Add to instructions</Button>
        <Button variant="ghost" size="sm" className={TOUCH_CONTROL} onClick={settle}>Discard</Button>
        {!fits && <span className="text-xs text-muted-foreground">Too long to add. Shorten it or your instructions first.</span>}
      </div>
    </div>}
  </div>;
}

function SectionHeading({ icon, tone = "primary", title, description }: { icon: IconName; tone?: Tone; title: string; description?: string }) {
  return <div className="flex items-start gap-3">
    <IconTile tone={tone} icon={icon} />
    <div className="min-w-0"><h2 className="text-sm font-semibold">{title}</h2>{description && <p className="mt-1 max-w-[75ch] text-sm text-muted-foreground">{description}</p>}</div>
  </div>;
}

/**
 * Review settings, in BB's Settings and as the panel's own page, where `onBack` adds its page bar, back to where you
 * came from (`back`). Plain function: the host slot collector requires a component function.
 */
export function ReviewSettings({ onBack, back }: { onBack?: () => void; back?: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const session = useReviewSession();
  const [record, setRecord] = useState<PreferencesRecord | null>(null);
  const [baseline, setBaseline] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [saved, setSaved] = useState(false);
  const [machines, setMachines] = useState<Machines>(undefined);
  const [numberText, setNumberText] = useState<KnobNumberText>({});
  useEffect(() => {
    rpc.call("listMachines", null).then((result) => setMachines(result.machines), () => setMachines(null));
  }, [rpc]);
  // Each machine's providers, by host ("" for the bb server), read once its agent is placed there; none when unread.
  const [providerModes, setProviderModes] = useState<Readonly<Record<string, ProviderModes>>>({});
  const providerReads = useRef(new Map<string, Promise<ProviderModes>>());
  const readProviders = useCallback((host: string) => {
    let read = providerReads.current.get(host);
    if (!read) {
      read = rpc.call("getProviderModes", host ? { hostId: host } : {}).then((result) => result.providers, () => []);
      providerReads.current.set(host, read);
      void read.then((providers) => setProviderModes((current) => ({ ...current, [host]: providers })));
    }
    return read;
  }, [rpc]);
  const agentHosts = [record?.preferences.guideAgent?.hostId ?? "", record?.preferences.assistantAgent?.hostId ?? ""];
  useEffect(() => { for (const host of ["", ...agentHosts]) void readProviders(host); }, [readProviders, agentHosts.join("\n")]);
  // Project defaults' provider, read only when a provider on the bb server can't be restricted.
  const [defaultProviderId, setDefaultProviderId] = useState<string>();
  const serverUnrestricted = providerModes[""]?.some((provider) => !restrictable(provider)) ?? false;
  useEffect(() => {
    if (serverUnrestricted) rpc.call("getAgentDefaults", null).then((result) => setDefaultProviderId(result.defaults?.providerId), () => {});
  }, [rpc, serverUnrestricted]);
  const unrestricted = (agent: AgentExecution | null) => agent ? unrestrictedNote(providerModes[agent.hostId ?? ""] ?? [], agent.providerId)
    : unrestrictedNote(providerModes[""] ?? [], defaultProviderId);
  const load = useCallback(async () => {
    setError("");
    try { const result = await rpc.call("getPreferences", null); show({ ...result, preferences: withDefaults(result.preferences) }); }
    catch { setError("Couldn’t load settings. Try again."); }
  }, [rpc]);
  useEffect(() => { void load(); }, [load]);
  /** Shows settings as loaded or saved, with nothing left to save. */
  function show(next: PreferencesRecord) {
    setRecord(next); setBaseline(JSON.stringify(next.preferences)); setNumberText({});
  }
  // A number being typed goes once its parent is off, so Save doesn't wait on a box you can't fix.
  useEffect(() => { if (record) setNumberText((current) => enabledNumberText(current, record.preferences)); }, [record]);
  // A number still being typed counts, so Discard edits can clear it.
  const dirty = record !== null && (baseline !== JSON.stringify(record.preferences) || Object.keys(numberText).length > 0);
  // A custom selection is complete once the host pickers resolve a provider and model, and a number once it's in range.
  const incomplete = [record?.preferences.guideAgent, record?.preferences.assistantAgent].some((agent) => agent && (!agent.providerId || !agent.model))
    || Object.keys(numberText).length > 0;
  const saveable = dirty && !incomplete && !busy && !updating;
  function setAgent(key: "guideAgent" | "assistantAgent", update: AgentUpdate) {
    setSaved(false);
    // Functional: both pickers can report reconciled values in the same render.
    setRecord((current) => current && { ...current, preferences: { ...current.preferences, [key]: update(current.preferences[key]) } });
  }
  function setKnob<K extends KnobId>(id: K, value: Knobs[K]) {
    setSaved(false);
    setRecord((current) => current && { ...current, preferences: { ...current.preferences, knobs: { ...current.preferences.knobs, [id]: value } } });
  }
  const knob = (id: KnobId) => record && <KnobControl id={id} record={record.preferences} onChange={setKnob} numberText={numberText}
    onNumberText={(key, text) => { setSaved(false); setNumberText(({ [key]: _previous, ...rest }) => text === undefined ? rest : { ...rest, [key]: text }); }} />;
  async function customize(key: "guideAgent" | "assistantAgent") {
    // Without defaults, the guide writer starts at bb's lowest mode.
    let seed: AgentExecution = { providerId: "", model: "", reasoningLevel: "medium", permissionMode: key === "guideAgent" ? "accept-edits" : "auto" };
    try {
      const { defaults, guideWriterMode } = await rpc.call("getAgentDefaults", null);
      seed = defaults ?? seed;
      // The guide writer needs no shell or edits, so it starts at the lowest mode its provider runs in, as on Project
      // defaults: accept-edits, else auto, else the provider's only mode.
      if (key === "guideAgent" && defaults) {
        const modes = (await readProviders("")).find((provider) => provider.id === defaults.providerId)?.permissionModes;
        const only = modes?.length === 1 ? (["accept-edits", "auto", "full"] as const).find((mode) => mode === modes[0]) : undefined;
        seed = { ...seed, permissionMode: guideWriterMode ?? only ?? seed.permissionMode };
      }
    } catch { /* The pickers resolve bb's own defaults from the empty seed. */ }
    setAgent(key, (agent) => agent ?? seed);
  }
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);
  async function save() {
    if (!record || busy || updating) return;
    setBusy(true); setError(""); setSaved(false);
    try { const result = await rpc.call("savePreferences", record); show({ ...result, preferences: withDefaults(result.preferences) }); setSaved(true); }
    catch (error) { setError(error instanceof Error ? error.message : "Couldn’t save settings. Your edits are still here."); }
    finally { setBusy(false); }
  }
  const knobs = record?.preferences.knobs ?? defaultKnobs;
  const automaticReviewDim = knobs.runAutomaticReview ? "" : DISABLED_TEXT;
  const reReviewCheckDim = knobs.runReReviewCheck ? "" : DISABLED_TEXT;
  const autoStartWhen = !knobs.unattendedAgents ? "Start agents on their own is off, so these guides wait for your click."
    : !knobs.alertTurns ? "When your review is requested there, the guide starts right away."
    : "When your review is requested there, the guide is ready by the time you’re alerted.";
  if (!session.ready) return <div className="space-y-3 p-6"><p role={session.error ? "alert" : "status"}>{session.error || "Opening settings…"}</p>{session.error && <Button className={TOUCH_CONTROL} onClick={session.retry}>Try again</Button>}</div>;
  return <div className="flex h-full min-h-0 min-w-0 flex-col" style={{ backgroundColor: "rgb(from var(--background) r g b / 1)" }}>
    {/* Back waits for your edits to be saved or discarded. */}
    {onBack && <PageBar back={back} onBack={onBack} backDisabled={dirty || busy || updating} title="Settings" />}
    <div className="min-h-0 flex-1 overflow-y-auto">
    <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-5 sm:px-8">
      <p className="max-w-[75ch] pb-2 text-sm text-muted-foreground">Shape your guides, how the review agent helps, and how reviews read. Applies across this BB installation.</p>
      <SetupReadiness account={<AccountBar />} />
      <ReleaseSettings clientId={session.clientId} disabled={dirty || busy} onUpdatingChange={setUpdating} />
      {error && <div role="alert" className="space-y-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive-text"><p className="flex items-start gap-2"><Icon name="AlertCircle" className="mt-0.5 size-4 shrink-0" aria-hidden />{error}</p><Button variant="outline" size="sm" className={TOUCH_CONTROL} disabled={busy || updating} onClick={() => void load()}>Reload saved settings</Button></div>}
      {/* How to set up Needs You shows while settings load, or when they can't; the toggles once they have. */}
      <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-xs">
        <SectionHeading icon="Mail" title="Notifications" description="What Needs You alerts you about." />
        {record && <fieldset disabled={busy || updating} className="min-w-0 space-y-4">
          {knob("alertGuides")}
          {knob("alertTurns")}
        </fieldset>}
        <p className="max-w-[75ch] text-sm text-muted-foreground">Alerts go to Needs You. Each links back to the review and clears when you open it. Install or update Needs You to 0.2.0-beta.3 or later, then enable Extension activity in its Settings. Telegram is optional.</p>
        {/* A BB route, so it opens in this window, as BB's own links do. */}
        <UrlLink className={`relative inline-block text-sm text-primary underline underline-offset-4 ${TOUCH_TARGET}`} href="/plugins/inbox/inbox/settings">Open Needs You settings</UrlLink>
      </section>
      {!record ? !error && <p role="status">Loading settings…</p> : <>
        {/* min-w-0: a fieldset is otherwise as wide as its widest line, past a phone's edge. */}
        <fieldset disabled={busy || updating} className="min-w-0 space-y-4">
          <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-xs">
            <SectionHeading icon="Route" title="Guide generation" description="Used to build a guide, and to update or rebuild one. Existing guides stay as written." />
            <AgentSelection label="Guide writer agent" agent={record.preferences.guideAgent} unrestricted={unrestricted(record.preferences.guideAgent)} defaults="the agent, model, and effort bb remembers for the project the review runs in, at the lowest permissions that agent runs in" machines={machines} disabled={busy || updating} onCustomize={() => void customize("guideAgent")} onChange={(update) => setAgent("guideAgent", update)} />
            <div className="space-y-2"><p id="guide-detail-label" className="text-sm font-medium">Detail level</p><div role="group" aria-labelledby="guide-detail-label" className="flex flex-wrap gap-2">
              {(["concise", "standard", "detailed"] as const).map((value) => <Button key={value} variant="outline" size="sm" className={CHOICE} aria-pressed={record.preferences.guideDetail === value} onClick={() => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, guideDetail: value } }); }}>{value[0].toUpperCase() + value.slice(1)}</Button>)}
            </div></div>
            <label className="block space-y-2"><span className="text-sm font-medium">Guide instructions</span><Textarea aria-label="Guide instructions" maxLength={12000} rows={6} value={record.preferences.guideInstructions} onChange={(event) => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, guideInstructions: event.target.value } }); }} placeholder="Explain data migrations and compatibility. Keep tests with the behavior they cover. Write for engineers new to this repository." /><span className="block text-xs text-muted-foreground">Add review priorities, language, and team conventions. These extend the built-in guide skill.</span></label>
            <details className="text-sm"><summary className={`relative w-fit cursor-pointer rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${TOUCH_TARGET}`}>About the guide skill</summary><div className="mt-3 space-y-2 text-muted-foreground"><p>The bundled skill reads the complete diff, organizes chapters by meaning, and covers every changed file exactly once. Custom instructions shape its explanations while the required output format stays validated.</p><p>Based on the chaptered walkthrough approach from <a className="underline underline-offset-4" href="https://github.com/plannotator/guides/blob/main/skills/plannotator-guide/SKILL.md" target="_blank" rel="noreferrer">Plannotator’s guide skill</a>, adapted for BB. Guides run through the agent selected above.</p></div></details>
          </section>
          <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-xs">
            <SectionHeading icon="Sparkles" tone="agent" title="Review agent" description="Applies to your next message, including conversations already in progress." />
            <AgentSelection label="Review agent" agent={record.preferences.assistantAgent} unrestricted={unrestricted(record.preferences.assistantAgent)} machines={machines} disabled={busy || updating} note="Used to start new conversations, which stay on the machine they started on. In a conversation, change the model and effort per message." onCustomize={() => void customize("assistantAgent")} onChange={(update) => setAgent("assistantAgent", update)} />
            <label className="block space-y-2"><span className="text-sm font-medium">Assistant instructions</span><Textarea aria-label="Assistant instructions" maxLength={ASSISTANT_INSTRUCTIONS_LIMIT} rows={5} value={record.preferences.assistantInstructions} onChange={(event) => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, assistantInstructions: event.target.value } }); }} placeholder="Prioritize correctness and security. Show a concrete failure case for suspected bugs. Keep suggestions actionable." /></label>
            <AgentCommentLearning instructions={record.preferences.assistantInstructions} onAdd={(lines) => { setSaved(false); setRecord((current) => current && { ...current, preferences: { ...current.preferences, assistantInstructions: [current.preferences.assistantInstructions.trim(), lines].filter(Boolean).join("\n") } }); }} />
            {knob("runAutomaticReview")}
            <label className="ml-6 block space-y-2"><span className={`text-sm font-medium ${automaticReviewDim}`}>Automatic review</span><Textarea aria-label="Automatic review" disabled={!record.preferences.knobs.runAutomaticReview} maxLength={12000} rows={4} value={record.preferences.automaticReview} onChange={(event) => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, automaticReview: event.target.value } }); }} /><span className={`block text-xs text-muted-foreground ${automaticReviewDim}`}>Sent to the review agent when a guide is ready and the review has no conversation yet. Its draft comments wait in Comments for you to edit and submit. Leave blank to turn the automatic review off.</span></label>
            {knob("recheckOnNewCommits")}
          </section>
          <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-xs">
            <SectionHeading icon="ListTodo" title="Whose turn" description="What brings a review back to Needs review, and which reviews to follow." />
            <div className="space-y-2"><p id="wake-on-replies-label" className="text-sm font-medium">When the author replies</p><div role="group" aria-labelledby="wake-on-replies-label" className="flex flex-wrap gap-2">
              {([ ["questions", "Questions for you"], ["any", "Any reply"] ] as const).map(([value, label]) => <Button key={value} variant="outline" size="sm" className={CHOICE} aria-pressed={record.preferences.wakeOnReplies === value} onClick={() => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, wakeOnReplies: value } }); }}>{label}</Button>)}
            </div></div>
            {knob("mentionsWake")}
            {knob("prepareOnReturn")}
            {knob("runReReviewCheck")}
            <label className="ml-6 block space-y-2"><span className={`text-sm font-medium ${reReviewCheckDim}`}>Re-review check</span><Textarea aria-label="Re-review check" disabled={!record.preferences.knobs.runReReviewCheck} maxLength={12000} rows={4} value={record.preferences.verificationPrompt} onChange={(event) => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, verificationPrompt: event.target.value } }); }} /><span className={`block text-xs text-muted-foreground ${reReviewCheckDim}`}>Sent to the review agent when a review comes back to you. Leave blank to turn it off.</span></label>
            <div className="ml-6 space-y-2"><p id="push-checks-label" className={`text-sm font-medium ${reReviewCheckDim}`}>After the author pushes</p><div role="group" aria-labelledby="push-checks-label" aria-describedby="push-checks-help" className="flex flex-wrap gap-2">
              {([ ["off", "Do nothing"], ["progress", "Check my feedback"], ["ready", "Check, and bring it back when everything’s addressed"] ] as const).map(([value, label]) => <Button key={value} variant="outline" size="sm" className={CHOICE} disabled={!record.preferences.knobs.runReReviewCheck} aria-pressed={record.preferences.pushChecks === value} onClick={() => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, pushChecks: value } }); }}>{label}</Button>)}
            </div><p id="push-checks-help" className={`text-xs text-muted-foreground ${reReviewCheckDim}`}>The review agent checks once the author’s pushes settle.</p></div>
            <label className="flex items-start gap-2.5"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={record.preferences.trackGithubReviews} onChange={(event) => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, trackGithubReviews: event.target.checked } }); }} /><span className="space-y-1"><span className="block text-sm font-medium">Track reviews from GitHub</span><span className="block text-xs text-muted-foreground">Show PRs you’re asked to review or have reviewed on GitHub, not only reviews started here.</span></span></label>
            <label className="ml-6 flex items-start gap-2.5"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" disabled={!record.preferences.trackGithubReviews} checked={record.preferences.trackTeamRequests} onChange={(event) => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, trackTeamRequests: event.target.checked } }); }} /><span className={`space-y-1 ${record.preferences.trackGithubReviews ? "" : DISABLED_TEXT}`}><span className="block text-sm font-medium">Include team requests</span><span className="block text-xs text-muted-foreground">Also show PRs that ask a team you’re on for review. Teams can be asked for many reviews.</span></span></label>
            {knob("trackReviewedPrs")}
            <label className="block space-y-2"><span className="text-sm font-medium">Start guides automatically</span><RepoPatterns value={record.preferences.autoStartRepos} onChange={(autoStartRepos) => { setSaved(false); setRecord((current) => current && { ...current, preferences: { ...current.preferences, autoStartRepos } }); }} /><span id="auto-start-help" className="block text-xs text-muted-foreground">One per line: <code className="font-mono">owner/repo</code>, <code className="font-mono">owner/*</code>, or <code className="font-mono">*</code>. {autoStartWhen}</span></label>
          </section>
          <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-xs">
            <SectionHeading icon="GitCommit" title="Re-reviews" description="A PR you reviewed that has changed since." />
            <div className="space-y-2"><p id="rereview-shows-label" className="text-sm font-medium">On a re-review, show</p><div role="group" aria-labelledby="rereview-shows-label" aria-describedby="rereview-shows-help" className="flex flex-wrap gap-2">
              {([ ["since", "Changes since your review"], ["all", "All changes"] ] as const).map(([value, label]) => <Button key={value} variant="outline" size="sm" className={CHOICE} aria-pressed={record.preferences.rereviewShows === value} onClick={() => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, rereviewShows: value } }); }}>{label}</Button>)}
            </div><p id="rereview-shows-help" className="text-xs text-muted-foreground">Switch any time above a chapter’s files. Your switch holds for that review until its guide updates for new commits.</p></div>
          </section>
          <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-xs">
            <SectionHeading icon="FileText" title="Reading" description="How a review opens, and what shows around the code. How the code draws is in each review’s Diff options." />
            {knob("returnToOverview")}
            {knob("singleKeyShortcuts")}
            {knob("foldViewedFiles")}
            {knob("foldGeneratedFiles")}
            {knob("requirements")}
            {knob("codeOwners")}
            {knob("ciInCode")}
          </section>
          <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-xs">
            <SectionHeading icon="MessageSquare" title="Comments and Finish review" description="What selecting code offers, and what Finish review checks before you submit." />
            {knob("askAboutSelection")}
            {knob("approveGuard")}
            {knob("approveGuardPace")}
          </section>
          <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-xs">
            <SectionHeading icon="PanelLeft" title="BB’s thread list" />
            <label className="flex items-start gap-2.5"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={record.preferences.threadListReviews} onChange={(event) => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, threadListReviews: event.target.checked } }); }} /><span className="space-y-1"><span className="block text-sm font-medium">Show reviews in the thread list</span><span className="block text-xs text-muted-foreground">Adds Needs review below Threads, and lets you pin reviews with your pinned threads. BB has no supported place for plugins there, so Guided Review adds them to BB’s own list. If a BB update makes that list misbehave, or you’d rather keep it to threads, turn this off. Your pins are kept for when you turn it back on.</span></span></label>
          </section>
          <section className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-xs">
            <SectionHeading icon="Lock" title="Trust" description="A PR’s description, comments, and code can try to steer an agent that reads them. Choose what runs without your click." />
            {knob("unattendedAgents")}
            <div className="space-y-2"><p id="unattended-authors-label" className="text-sm font-medium">Run agents on their own for PRs from</p><div role="group" aria-labelledby="unattended-authors-label" aria-describedby="unattended-authors-help" className="flex flex-wrap gap-2">
              {([ ["members", "Members and collaborators"], ["anyone", "Anyone"] ] as const).map(([value, label]) => <Button key={value} variant="outline" size="sm" className={CHOICE} aria-pressed={record.preferences.unattendedAuthors === value} onClick={() => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, unattendedAuthors: value } }); }}>{label}</Button>)}
            </div><p id="unattended-authors-help" className="text-xs text-muted-foreground">{knobs.unattendedAgents
              ? "For other authors, no guide, automatic review, or feedback check starts by itself: the review says why, with a button to run it. Your own PRs and local reviews always run, unless the PR’s branch is in someone else’s fork."
              : "Start agents on their own is off: on other people’s PRs, nothing starts until you click. This choice still decides whose PRs the repo’s tests and linters may run on."}</p></div>
            <label className="flex items-start gap-2.5"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={record.preferences.runRepoChecks} onChange={(event) => { setSaved(false); setRecord({ ...record, preferences: { ...record.preferences, runRepoChecks: event.target.checked } }); }} /><span className="space-y-1"><span className="block text-sm font-medium">Let the review agent run the repo’s tests and linters</span><span className="block text-xs text-muted-foreground">This runs the PR’s code on the agent’s machine, in a temporary git worktree, with the check commands the repo documents. Only on your own PRs and PRs from the authors above.</span></span></label>
            {record.preferences.unattendedAuthors === "anyone" && record.preferences.runRepoChecks && <p className="flex items-start gap-1.5 pl-6.5 text-xs text-warning-text"><Icon name="AlertTriangle" className="mt-px size-3.5 shrink-0" aria-hidden />With Anyone, this runs code from any GitHub user’s PR, forks included, on this server, where gh is signed in.</p>}
          </section>
        </fieldset>
        <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border bg-background/90 py-2.5 backdrop-blur">
          {/* Unavailable rather than disabled, so focus stays on it as it saves, and it's announced as unavailable. */}
          <Button className={`${TOUCH_CONTROL} ${UNAVAILABLE}`} aria-disabled={!saveable} onClick={() => { if (saveable) void save(); }}>{busy ? "Saving…" : "Save settings"}</Button>
          {dirty && <Button variant="ghost" className={TOUCH_CONTROL} disabled={busy || updating} onClick={() => { setRecord({ ...record, preferences: JSON.parse(baseline) }); setNumberText({}); setError(""); }}>Discard edits</Button>}
          <span role="status" className="text-xs text-muted-foreground">{saved ? "Settings saved" : dirty ? "Unsaved changes" : ""}</span>
          {/* The diff layout isn't on this page: the review's Diff options set it. */}
          <Button variant="ghost" size="sm" className={`ml-auto ${TOUCH_CONTROL}`} disabled={busy || updating} onClick={() => { setSaved(false); setNumberText({}); setRecord({ ...record, preferences: { ...defaultPreferences, knobs: { ...defaultKnobs }, diffLayout: record.preferences.diffLayout } }); }}>Restore defaults</Button>
        </div>
      </>}
    </div>
    </div>
  </div>;
}

/** Settings as the panel's page: back to the review it was opened from (`returnTo`), or else to All reviews. */
export function ReviewSettingsPage({ returnTo = "" }: { returnTo?: string }) {
  const navigate = useBbNavigate();
  return <ReviewSettings back={returnTo ? "Back to review" : "All reviews"} onBack={() => navigate.toPluginPanel("review", { subPath: returnTo })} />;
}
