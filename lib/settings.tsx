import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { experimental_usePluginId, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import { KNOB_RANGES, defaultKnobs, type KnobId, type Knobs } from "./knobs";
import { defaultPreferences, type ReviewPreferences } from "./review-preferences";

interface Settings {
  preferences: ReviewPreferences;
  /** Resolves once, with the first load's settings, or `fallback` when they couldn't load. */
  settled: Promise<ReviewPreferences>;
  /** What stands in for settings that haven't loaded: the last knobs this browser loaded, else the defaults. */
  fallback: ReviewPreferences;
}

/** Defaults outside a provider: tests, BB's title bar, BB's settings slot. */
export const SettingsContext = createContext<Settings>({ preferences: defaultPreferences, settled: Promise.resolve(defaultPreferences), fallback: defaultPreferences });

const knobsKey = (pluginId: string) => `gr:knobs:${pluginId}`;

/**
 * The knobs this browser last loaded for the install, read as src/preferences.ts readKnobs reads saved ones: each
 * missing or invalid one at its default. Null when none were stored.
 */
export function storedKnobs(pluginId: string): Knobs | null {
  let saved: unknown;
  try {
    const text = localStorage.getItem(knobsKey(pluginId));
    if (text === null) return null;
    saved = JSON.parse(text);
  } catch { return null; }
  const record = saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
  const ranges: Partial<Record<string, { min: number; max: number }>> = KNOB_RANGES;
  return Object.fromEntries(Object.entries(defaultKnobs).map(([key, fallback]) => {
    const value = record[key];
    const range = ranges[key];
    const valid = range ? Number.isInteger(value) && (value as number) >= range.min && (value as number) <= range.max : typeof value === typeof fallback;
    return [key, valid ? value : fallback];
  })) as unknown as Knobs;
}

function storeKnobs(pluginId: string, knobs: Knobs) {
  try { localStorage.setItem(knobsKey(pluginId), JSON.stringify(knobs)); } catch { /* optional persistence */ }
}

/** A loaded record with any missing setting or knob at its default: mocks and older servers may lack some. */
export function withDefaults(preferences: Partial<ReviewPreferences>): ReviewPreferences {
  return { ...defaultPreferences, ...preferences, knobs: { ...defaultKnobs, ...preferences.knobs } };
}

/**
 * Loads settings on mount, again on realtime "preferences", and keeps the last good ones when a load fails. Until one
 * loads, the knobs this browser last loaded stand in, so a switch you turned off, like single-key shortcuts, stays off.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const rpc = useRpc<typeof rpcContract>();
  const pluginId = experimental_usePluginId();
  const [fallback] = useState<ReviewPreferences>(() => { const knobs = storedKnobs(pluginId); return knobs ? { ...defaultPreferences, knobs } : defaultPreferences; });
  const [preferences, setPreferences] = useState(fallback);
  const [first] = useState(() => {
    let settle!: (preferences: ReviewPreferences) => void;
    const settled = new Promise<ReviewPreferences>((resolve) => { settle = resolve; });
    return { settled, settle };
  });
  const good = useRef(fallback);
  // Only the latest request lands, so two quick reloads can't apply out of order.
  const latest = useRef(0);
  const load = useCallback(() => {
    const request = ++latest.current;
    void Promise.resolve().then(() => rpc.call("getPreferences", null)).then((result) => withDefaults(result.preferences), () => null).then((loaded) => {
      // The first load settles from any answer, so a newer reload that hangs can't hold it.
      if (request !== latest.current) { first.settle(loaded ?? good.current); return; }
      if (loaded) { good.current = loaded; setPreferences(loaded); storeKnobs(pluginId, loaded.knobs); }
      first.settle(good.current);
    });
  }, [rpc, first, pluginId]);
  useEffect(load, [load]);
  useRealtime("preferences", load);
  const value = useMemo(() => ({ preferences, settled: first.settled, fallback }), [preferences, first, fallback]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Settings {
  return useContext(SettingsContext);
}

export function useKnob<K extends KnobId>(id: K): Knobs[K] {
  return useContext(SettingsContext).preferences.knobs[id];
}
