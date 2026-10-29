// 1.8.0's RPC methods whose builds haven't landed: each answers that it isn't available yet. The step that builds one
// deletes its line here and gives the handler from its own module. Until step 2.1 lands, Send to thread's `letPush` and
// `force` are taken and not acted on: a Send goes as it did without them.
import type { RpcHandlers } from "./server-modules";

const notYet = (what: string) => async (): Promise<never> => { throw new Error(`${what} isn’t available yet.`); };

export function register() {
  const handlers = {
    sendNow: notYet("Send now"), // Step 2.1; GitHub threads, 4.2.

    resolveComment: notYet("Resolve"), // Step 2.3.

    reopenComment: notYet("Reopen"), // Step 2.3.

    checkFixes: notYet("Check fixes"), // Step 2.2.

    push: notYet("Push"), // Step 5.1.

    setMainThread: notYet("Changing the main thread"), // Step 2.1.

    setLetPush: notYet("Let it push when done"), // Step 2.1.
  } satisfies Partial<RpcHandlers>;
  return { handlers };
}
