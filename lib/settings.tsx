import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import { defaultKnobs, type KnobId, type Knobs } from "./knobs";
import { defaultPreferences, type ReviewPreferences } from "./review-preferences";

interface Settings {
  preferences: ReviewPreferences;
  /** Resolves once, with the first load's settings, or the defaults when they couldn't load. */
  settled: Promise<ReviewPreferences>;
}

/** Defaults outside a provider: tests, BB's title bar, BB's settings slot. */
export const SettingsContext = createContext<Settings>({ preferences: defaultPreferences, settled: Promise.resolve(defaultPreferences) });

/** A loaded record with any missing setting or knob at its default: mocks and older servers may lack some. */
export function withDefaults(preferences: Partial<ReviewPreferences>): ReviewPreferences {
  return { ...defaultPreferences, ...preferences, knobs: { ...defaultKnobs, ...preferences.knobs } };
}

/** Loads settings on mount, again on realtime "preferences", and keeps the last good ones when a load fails. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const rpc = useRpc<typeof rpcContract>();
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [first] = useState(() => {
    let settle!: (preferences: ReviewPreferences) => void;
    const settled = new Promise<ReviewPreferences>((resolve) => { settle = resolve; });
    return { settled, settle };
  });
  const good = useRef(defaultPreferences);
  // Only the latest request lands, so two quick reloads can't apply out of order.
  const latest = useRef(0);
  const load = useCallback(() => {
    const request = ++latest.current;
    void Promise.resolve().then(() => rpc.call("getPreferences", null)).then((result) => withDefaults(result.preferences), () => null).then((loaded) => {
      if (request !== latest.current) return;
      if (loaded) { good.current = loaded; setPreferences(loaded); }
      first.settle(good.current);
    });
  }, [rpc, first]);
  useEffect(load, [load]);
  useRealtime("preferences", load);
  const value = useMemo(() => ({ preferences, settled: first.settled }), [preferences, first]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Settings {
  return useContext(SettingsContext);
}

export function useKnob<K extends KnobId>(id: K): Knobs[K] {
  return useContext(SettingsContext).preferences.knobs[id];
}
