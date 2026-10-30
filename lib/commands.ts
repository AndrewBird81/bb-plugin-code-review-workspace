// Code Review Workspace's commands in BB's command palette. A command's run gets no RPC and no navigation, so it posts here, and
// the handler that BB's always-mounted app overlay runs (components/NeedsReviewSidebar.tsx) does the work.
import { useEffect } from "react";
import { toast } from "sonner";
import { experimental_usePluginId, useBbNavigate, useRpc, type PluginCommandContext } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";
import { parsePrLink } from "./pr-link";
import { needsOrder, reviewState, type ReviewItem } from "./review-state";
import { threadEnvironment, threadLinksNow, threadReview } from "./thread-links";
import { lastReviewInUse, panelPage, workspaceFor } from "./workspace-store";

/** What a palette command asks for; `text` is the clipboard's, null when it couldn't be read. */
export type PaletteCommand = { kind: "next" } | { kind: "clipboard"; text: string | null } | { kind: "all" } | { kind: "switch"; to: SwitchTarget };

/** Where Switch between review and main thread goes: a thread's review, or a review's main thread. */
export type SwitchTarget = { kind: "review"; targetKey: string } | { kind: "thread"; threadId: string };

// The id the plugin is installed under, as the overlay says: code-review-workspace, unless installed under another.
let installedAs = "code-review-workspace";

/** The review a Code Review Workspace page shows, from its address, which a command isn't told. */
export function reviewInView(href: string = typeof location === "undefined" ? "" : location.href): string | null {
  const prefix = `/plugins/${installedAs}/review/`;
  const at = href.indexOf(prefix);
  const subPath = at < 0 ? null : href.slice(at + prefix.length).split(/[?#]/)[0];
  if (!subPath) return null;
  const page = panelPage(decodeURIComponent(subPath));
  return page.kind === "review" ? page.targetKey : null;
}

/**
 * The other side of the work from where you are: on a thread's page, its review (as its Review tab finds it); on a
 * review's page, its main thread. Null where there's no counterpart, or it isn't known yet.
 */
export function switchTarget({ threadId }: Pick<PluginCommandContext, "threadId">, href = location.href): SwitchTarget | null {
  if (threadId) {
    const links = threadLinksNow();
    const link = links && threadReview(links, threadId, threadEnvironment(threadId));
    return link ? { kind: "review", targetKey: link.targetKey } : null;
  }
  // The review you're working in, of the panes; else the one the address shows.
  const inUse = lastReviewInUse();
  const targetKey = inUse && workspaceFor(inUse) ? inUse : reviewInView(href);
  const main = targetKey ? workspaceFor(targetKey)?.mainThread : null;
  return main ? { kind: "thread", threadId: main.threadId } : null;
}

let handler: ((command: PaletteCommand) => void) | null = null;
let paletteCommands = true;

/** Commands in BB's command palette, the knob, as the overlay last loaded it: on until it loads. */
export function setPaletteCommands(on: boolean) { paletteCommands = on; }

/** Whether the palette lists the commands: the knob is on, and an overlay is there to handle them, which hosts without app overlays never have. */
export function paletteCommandsAvailable(): boolean { return paletteCommands && handler !== null; }

export function postPaletteCommand(command: PaletteCommand) { handler?.(command); }

/** Switch between review and main thread's default key, as it reads on this computer. */
export const SWITCH_KEY = { key: ".", mod: true, shift: true } as const;
const switchKeyLabel = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘⇧." : "Ctrl+Shift+.";

/**
 * A go-to control's tooltip, with the switch's default key while the palette lists it. BB doesn't tell a plugin a key
 * you bound instead.
 */
export function switchHint(label: string): string {
  return paletteCommandsAvailable() ? `${label} · ${switchKeyLabel()}` : label;
}

/** The clipboard's text, or null where the browser won't give it. */
export async function readClipboard(): Promise<string | null> {
  try { return await navigator.clipboard.readText(); } catch { return null; }
}

/** Handles the palette's commands while mounted: lists reviews, starts one, and opens the panel. */
export function usePaletteCommands() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  useEffect(() => { installedAs = pluginId; }, [pluginId]);
  useEffect(() => {
    const open = (targetKey?: string) => navigate.toPluginPanel("review", targetKey ? { subPath: targetKey } : undefined);
    const list = () => rpc.call("listReviews", null).then((result) => result.reviews as ReviewItem[]);
    async function run(command: PaletteCommand) {
      if (command.kind === "all") { open(); return; }
      if (command.kind === "switch") {
        if (command.to.kind === "review") open(command.to.targetKey);
        else navigate.toThread(command.to.threadId);
        return;
      }
      if (command.kind === "next") {
        // The first review in Needs review's order.
        const next = (await list()).filter((review) => reviewState(review).group === "needs").sort(needsOrder)[0];
        if (next) open(next.targetKey);
        else toast.info("Nothing needs you.");
        return;
      }
      if (command.text === null) { toast.error("Couldn’t read the clipboard."); return; }
      const link = parsePrLink(command.text);
      if (!link) { toast.error("The clipboard has no PR link."); return; }
      // As pasting into All reviews does: open the review when it's listed, else start it.
      const listed = (await list()).find((review) => review.repo?.toLowerCase() === link.repo && review.number === link.number);
      if (listed) { open(listed.targetKey); return; }
      const result = await rpc.call("startReview", { input: link.url });
      if (!result.ok || !result.targetKey) { toast.error(result.error ?? "Couldn’t start the review. Try again."); return; }
      // Name the PR the clipboard held rather than open it unasked: Open is the way in.
      const targetKey = result.targetKey;
      const title = (await list().catch(() => [])).find((review) => review.targetKey === targetKey)?.title;
      toast.success(`Started a review of ${link.name}${title ? `: ${title}` : ""}`, { action: { label: "Open", onClick: () => open(targetKey) } });
    }
    const handle = (command: PaletteCommand) => {
      run(command).catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn’t reach Code Review Workspace. Try again."));
    };
    handler = handle;
    return () => { if (handler === handle) handler = null; };
  }, [rpc, navigate]);
}
