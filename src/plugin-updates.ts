import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import packageInfo from "../package.json" with { type: "json" };

export const releaseSchema = z.object({
  installedVersion: z.string(), automatic: z.boolean(), updating: z.boolean(),
  outcome: z.enum(["unchecked", "update-available", "current", "incompatible", "pinned", "unavailable"]),
  latestVersion: z.string().nullable(), candidateVersion: z.string().nullable(),
  checkedAt: z.number().nullable(), error: z.string().nullable(),
});
export type ReleaseStatus = z.infer<typeof releaseSchema>;
export const releaseRpc = {
  getReleaseStatus: { input: z.null(), output: releaseSchema },
  checkPluginUpdates: { input: z.null(), output: releaseSchema },
  setAutomaticUpdates: { input: z.object({ enabled: z.boolean() }).strict(), output: releaseSchema },
  setReviewPresence: { input: z.object({ clientId: z.string().min(1).max(100), open: z.boolean() }).strict(), output: z.object({ ok: z.boolean() }) },
  applyPluginUpdate: { input: z.object({ clientId: z.string().min(1).max(100), candidateVersion: z.string().min(1).max(512) }).strict(), output: z.object({ outcome: z.enum(["updated", "current", "rolled-back"]), version: z.string().nullable() }) },
};

const HOUR = 3_600_000;
const IDLE = 5 * 60_000;

export function createPluginUpdates(bb: BbPluginApi, backgroundBusy: () => boolean, now = Date.now) {
  const db = bb.storage.database();
  db.exec("CREATE TABLE IF NOT EXISTS plugin_updates (id INTEGER PRIMARY KEY CHECK(id=1), automatic INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0)");
  db.prepare("INSERT OR IGNORE INTO plugin_updates (id) VALUES (1)").run();
  const read = () => db.prepare("SELECT automatic, next_attempt FROM plugin_updates WHERE id=1").get() as { automatic: number; next_attempt: number };
  let current: ReleaseStatus = { installedVersion: packageInfo.version, automatic: !!read().automatic, updating: false, outcome: "unchecked", latestVersion: null, candidateVersion: null, checkedAt: null, error: null };
  let lastWork = now();
  let work = 0;
  let checking: Promise<ReleaseStatus> | null = null;
  // Never time out an editing window: a suspended laptop can still have unsaved
  // text. A lost close signal delays automatic updates until the plugin restarts.
  const views = new Set<string>();
  const status = (): ReleaseStatus => ({ ...current, automatic: !!read().automatic });
  function assertAvailable() { if (current.updating) throw new Error("Guided Review is updating. Try again in a moment."); }
  function idleReason(clientId?: string) {
    if (work || backgroundBusy()) return "Wait for review work to finish before updating.";
    if ([...views].some(id => id !== clientId)) return "Close other Guided Review pages before updating. Their unsaved edits are protected.";
    return null;
  }
  async function run<T>(operation: () => Promise<T> | T, touch = true): Promise<T> {
    assertAvailable(); work++; if (touch) lastWork = now();
    try { return await operation(); } finally { work--; if (touch) lastWork = now(); }
  }
  function presence(clientId: string, open: boolean) {
    if (open) { assertAvailable(); views.add(clientId); }
    else views.delete(clientId);
    lastWork = now();
    return { ok: true };
  }
  function setAutomatic(enabled: boolean) {
    assertAvailable(); db.prepare("UPDATE plugin_updates SET automatic=? WHERE id=1").run(enabled ? 1 : 0);
    current.automatic = enabled; return status();
  }
  async function check(): Promise<ReleaseStatus> {
    if (checking) return checking;
    checking = (async () => {
      try {
        const entry = (await bb.sdk.plugins.checkUpdates({ pluginId: bb.pluginId })).find(e => e.id === bb.pluginId);
        if (!entry) throw new Error("Missing result");
        current = { ...current, outcome: entry.outcome, latestVersion: entry.candidate?.display ?? entry.blocked?.version ?? null,
          candidateVersion: entry.candidate?.version ?? null, checkedAt: now(), error: null };
        return status();
      } catch {
        current = { ...current, outcome: "unavailable", candidateVersion: null, latestVersion: null, checkedAt: now(), error: "Couldn’t check for updates. Check the BB server’s connection and try again." };
        return status();
      } finally { checking = null; }
    })();
    return checking;
  }
  async function apply(clientId?: string, expectedCandidate?: string) {
    assertAvailable();
    const blocked = idleReason(clientId); if (blocked) throw new Error(blocked);
    // Reserve synchronously, before the first await. No save, CLI start, sync,
    // new editing window, or review submission can start during replacement.
    current.updating = true;
    try {
      const latest = await check();
      if (latest.outcome !== "update-available" || !latest.candidateVersion || (expectedCandidate && latest.candidateVersion !== expectedCandidate)) {
        throw new Error(latest.error ?? "The available update changed or is blocked. Check for updates again.");
      }
      db.prepare("UPDATE plugin_updates SET next_attempt=? WHERE id=1").run(now() + HOUR);
      // BB re-resolves the latest compatible release when installing; it does
      // not support applying a supplied exact candidate. Preserve its rollback.
      const result = await bb.sdk.plugins.applyUpdate({ pluginId: bb.pluginId });
      // The old runtime can be disposed now. Do not touch storage or SDK here.
      return { outcome: result.outcome, version: result.to?.display ?? null };
    } catch (error) {
      current.error = error instanceof Error ? error.message : "BB couldn’t complete the update. Check again before retrying.";
      throw error;
    } finally { current.updating = false; }
  }
  async function tick() {
    if (!read().automatic || current.updating || idleReason() || now() - lastWork < IDLE || now() < read().next_attempt) return;
    db.prepare("UPDATE plugin_updates SET next_attempt=? WHERE id=1").run(now() + HOUR);
    const latest = await check();
    // Check opt-in and activity again after the network wait. Turning updates
    // off or opening a review during that wait must take effect immediately.
    if (!read().automatic || idleReason() || now() - lastWork < IDLE || latest.outcome !== "update-available") return;
    try { await apply(undefined, latest.candidateVersion ?? undefined); } catch { /* retained in status, retry next hour */ }
  }
  return { status, check, apply, presence, setAutomatic, run, tick };
}
