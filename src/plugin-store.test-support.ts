// For tests, not the plugin: the store the plugin queues its calls through.
import { vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server";
import { queueStore, type AsyncStore } from "./store-queue";

/**
 * Start the plugin on `bb` and return the store it queues its calls through. Agents' configuration reads a view only
 * that queue keeps up to date, so a test writes what they should see through this store, not through a second queue
 * over the same database. The test file mocks ./store-queue's queueStore with vi.fn around the real one.
 */
export async function startPlugin(bb: BbPluginApi): Promise<AsyncStore> {
  const made = vi.mocked(queueStore).mock.results.length;
  await plugin(bb);
  return vi.mocked(queueStore).mock.results[made].value as AsyncStore;
}
