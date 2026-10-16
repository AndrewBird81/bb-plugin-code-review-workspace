// For tests, not the plugin: finds bb's provider and model picker fake once its first edit will stick.
import { act } from "@testing-library/react";

/**
 * Finds bb's picker fake in `scope`, then lets its mount effect run. The fake copies its `value` into its fields in that
 * effect; still pending at the first edit, React applies it after the edit and undoes it, as it did under full runs.
 * React runs a mount's effects in a later Scheduler task, which under Node it queues with setImmediate; immediates run
 * in the order they were queued, where a timer, as findByTestId's last wait, can run first.
 */
export async function findPicker(scope: { findByTestId(id: string): Promise<HTMLElement> }): Promise<HTMLElement> {
  const picker = await scope.findByTestId("bb-provider-model-picker");
  await act(async () => { await new Promise((resolve) => setImmediate(resolve)); });
  return picker;
}
