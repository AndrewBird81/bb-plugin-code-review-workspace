// Settings and setup: what the page checks first, the review settings, the agents' defaults and what they learned,
// saved filter views, and your GitHub account.
import { refreshAssistants } from "./agent";
import { listMachines, personalProjectId } from "./machines";
import { runGh } from "./gh";
import { guideWriterMode } from "./generate";
import { getGhAccounts, switchGhAccount, checkRepoAccess } from "./gh-accounts";
import { learningStats } from "./learning";
import type { RpcHandlers, ServeDeps } from "./server-modules";

export function register(deps: ServeDeps) {
  const { bb, store, suggester, sync } = deps;
  const handlers = {
    async getSetupStatus() {
      const [cli, user, providers, projects] = await Promise.all([
        runGh(["--version"]), runGh(["api", "user", "--jq", ".login"]),
        bb.sdk.providers.list().catch(() => null), bb.sdk.projects.list({ includePersonal: true }).catch(() => null),
      ]);
      return { githubCli: cli.code === 0, account: user.code === 0 ? user.stdout.trim() || null : null, agentAvailable: providers ? providers.some(p => p.available) : null, projectAvailable: projects ? projects.length > 0 : null };
    },
    async getPreferences() { return await store.getPreferences(); },
    async savePreferences({ preferences, revision }) {
      const { result, refresh } = await store.exclusive(async (tx) => {
        const before = (await tx.getPreferences()).preferences;
        const result = await tx.savePreferences({ ...preferences, threadListReviews: preferences.threadListReviews ?? before.threadListReviews, rereviewShows: preferences.rereviewShows ?? before.rereviewShows, markdownFiles: preferences.markdownFiles ?? before.markdownFiles, knobs: { ...before.knobs, ...preferences.knobs } }, revision);
        bb.realtime.publish("preferences", {});
        // These are in the assistants' instructions; whether they may run the repo's checks depends on the last two. So
        // are the agent checks the knobs turn on.
        const refresh = (["assistantInstructions", "runRepoChecks", "unattendedAuthors"] as const).some((key) => result.preferences[key] !== before[key])
          || (["preExistingFindings", "agentCoverage", "testWeakening"] as const).some((knob) => result.preferences.knobs[knob] !== before.knobs[knob]);
        return { result, refresh };
      });
      // Started after the block, which its reads of the store would wait for.
      if (refresh) void refreshAssistants(bb, store).catch((error) => bb.log.warn(`Could not restart the idle review assistants: ${String(error)}`));
      return result;
    },
    async getAgentDefaults() {
      // Panel-started reviews run in the personal project (see startReview).
      try {
        const projectId = await personalProjectId(bb);
        const d = projectId ? await bb.sdk.projects.defaultExecutionOptions({ projectId }) : null;
        // A custom guide writer starts at the mode it runs at on the defaults.
        const { permissionMode: writerMode } = projectId && d ? await guideWriterMode(bb, projectId, d) : {};
        return { defaults: d && { providerId: d.providerId, model: d.model, reasoningLevel: d.reasoningLevel, permissionMode: d.permissionMode, serviceTier: d.serviceTier }, ...(writerMode ? { guideWriterMode: writerMode } : {}) };
      } catch {
        return { defaults: null };
      }
    },
    async getProviderModes({ hostId }) {
      try {
        const providers = await bb.sdk.providers.list(hostId ? { hostId } : undefined);
        return { providers: providers.map((provider) => ({ id: provider.id, name: provider.displayName, permissionModes: [...provider.capabilities.permissionModes] })) };
      } catch {
        return { providers: [] };
      }
    },
    async listMachines() {
      return { machines: await listMachines(bb) };
    },
    async getAgentLearning() { return store.exclusive(async (tx) => { return { ...await learningStats(tx), canSuggest: await suggester.possible(tx), suggestion: suggester.current() }; }); },
    async suggestAssistantInstructions() { return await suggester.start(); },
    dismissInstructionSuggestion() { suggester.dismiss(); return { ok: true }; },
    async listFilterViews() { return { views: await store.listFilterViews() }; },
    async saveFilterView(view) {
      await store.saveFilterView(view);
      bb.realtime.publish("filter-views", { ts: Date.now() });
      return { ok: true as const };
    },
    async deleteFilterView({ id }) {
      await store.deleteFilterView(id);
      bb.realtime.publish("filter-views", { ts: Date.now() });
      return { ok: true as const };
    },
    // GitHub account indicator + switcher
    async getGhAccounts() {
      return getGhAccounts(runGh);
    },
    async switchGhAccount({ login }) {
      const r = await switchGhAccount(runGh, login);
      if (r.ok) {
        await sync.resetViewer();
        bb.realtime.publish("gh-account", { active: r.active });
      }
      return r;
    },
    async checkRepoAccess({ targetKey }) {
      const repo = (await store.getReview(targetKey))?.repo ?? null;
      return checkRepoAccess(runGh, repo);
    },
  } satisfies Partial<RpcHandlers>;
  return { handlers };
}
