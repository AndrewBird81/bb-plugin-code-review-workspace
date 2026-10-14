// For tests, not the plugin: read what the plugin handed the fake host.
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";

/** An agent tool result's text: the bare string, or its first text part. */
export function toolText(out: PluginAgentToolResult): string {
  if (typeof out === "string") return out;
  const first = out.content[0];
  return first?.type === "text" ? first.text : "";
}

/** Whether an agent tool reported an error; a bare string never does. */
export function toolFailed(out: PluginAgentToolResult): boolean {
  return typeof out !== "string" && out.isError === true;
}

/** The prompt of a `threads.spawn` call's first argument, failing the test if it has none. */
export function spawnPrompt(args: unknown): string {
  if (typeof args !== "object" || args === null || !("prompt" in args) || typeof args.prompt !== "string") throw new Error("expected a spawn with a prompt");
  return args.prompt;
}
