import { useEffect, useState, type ComponentProps } from "react";
import { useRpc, experimental_ProviderModelPicker as ProviderModelPicker } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import type { AgentChoice } from "../src/agent";
import { useSettings } from "../lib/settings";
import { MachineSelect, type Machines } from "./ReviewSettings";
import { cn } from "../lib/utils";

const UNSET_AGENT: AgentChoice = { providerId: "", model: "", reasoningLevel: "medium" };

/** An agent selection as spawn takes it: the machine, provider, model, effort, and tier, no permission mode. */
function choiceOf(agent: AgentChoice): AgentChoice {
  return { ...(agent.hostId ? { hostId: agent.hostId } : {}), providerId: agent.providerId, model: agent.model, reasoningLevel: agent.reasoningLevel, ...(agent.serviceTier ? { serviceTier: agent.serviceTier } : {}) };
}

/** Whether two selections start the same agent. A tier left out is the provider's default one. */
export function sameAgent(a: AgentChoice, b: AgentChoice): boolean {
  return (a.hostId ?? "") === (b.hostId ?? "") && a.providerId === b.providerId && a.model === b.model
    && a.reasoningLevel === b.reasoningLevel && (a.serviceTier ?? "default") === (b.serviceTier ?? "default");
}

const ROLES = {
  review: { label: "Review agent", setting: "assistantAgent" },
  guide: { label: "Guide writer", setting: "guideAgent" },
} as const;

/**
 * The agent picked as you start a review or build its guide: the review agent (`role` "review") or the guide writer
 * ("guide"). It starts at that agent's setting, else the agent, model, and effort bb remembers for the project it runs in
 * (`targetKey`'s, else the personal project panel-started reviews run in), as it would get with no pick. A pick goes to
 * this review or build alone; Settings stay as they are. `onChange` is told the pick, or null while it's the default, so
 * what starts falls back as one started without a pick does.
 */
export function AgentPicker({ role, targetKey, disabled, onChange, className }: {
  role: keyof typeof ROLES;
  targetKey?: string;
  disabled: boolean;
  onChange(agent: AgentChoice | null): void;
  className?: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { settled } = useSettings();
  const { label, setting } = ROLES[role];
  /** What it gets with no pick; undefined while it's read, UNSET_AGENT when there's none. */
  const [base, setBase] = useState<AgentChoice>();
  const [picked, setPicked] = useState<AgentChoice | null>(null);
  const [machines, setMachines] = useState<Machines>(undefined);
  useEffect(() => {
    let live = true;
    void settled.then(async (preferences) => {
      const custom = preferences[setting];
      const agent = custom ?? await rpc.call("getAgentDefaults", targetKey ? { targetKey } : null).then((result) => result.defaults, () => null);
      if (live) setBase(agent ? choiceOf(agent) : UNSET_AGENT);
    });
    rpc.call("listMachines", null).then((result) => { if (live) setMachines(result.machines); }, () => { if (live) setMachines(null); });
    return () => { live = false; };
  }, [rpc, settled, setting, targetKey]);
  const agent = picked ?? base;
  useEffect(() => { onChange(picked && base && !sameAgent(picked, base) ? picked : null); }, [picked, base, onChange]);
  if (!agent) return <p role="status" className={cn("px-2.5 py-1.5 text-xs text-muted-foreground", className)}>Loading the {label.toLowerCase()}…</p>;
  const hostId = agent.hostId;
  return <div role="group" aria-label={label} className={cn("flex min-w-0 flex-wrap items-center gap-2 px-2.5 py-1.5 text-sm", className)}>
    <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
    {/* Only where bb has more than one machine to run it on. */}
    {machines && machines.length > 1 && <MachineSelect hostId={hostId} machines={machines} disabled={disabled} onChange={(next) => setPicked((current) => {
      const { hostId: _previous, ...rest } = current ?? agent;
      return next ? { hostId: next, ...rest } : rest;
    })} />}
    {/* The SDK's types list the reasoning levels it knew; a provider's own passes through (lib/review-preferences.ts). */}
    <ProviderModelPicker disabled={disabled} routing={hostId ? { kind: "host", hostId } : undefined} className="min-w-0"
      value={agent as ComponentProps<typeof ProviderModelPicker>["value"]}
      onChange={(next) => setPicked(choiceOf({ ...(hostId ? { hostId } : {}), ...next }))} />
  </div>;
}
