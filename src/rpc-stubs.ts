// 1.8.0's RPC methods whose builds haven't landed: each answers that it isn't available yet. The step that builds one
// deletes its line here and gives the handler from its own module.
import type { RpcHandlers } from "./server-modules";

const notYet = (what: string) => async (): Promise<never> => { throw new Error(`${what} isn’t available yet.`); };

export function register() {
  const handlers = {
    resolveComment: notYet("Resolve"), // Step 2.3.

    reopenComment: notYet("Reopen"), // Step 2.3.
  } satisfies Partial<RpcHandlers>;
  return { handlers };
}
