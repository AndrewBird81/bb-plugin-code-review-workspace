import { useEffect } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";

/**
 * The review's page shows what its agent did, so while it shows in a window in view its agent's thread is read, as an
 * open thread is in BB: as it opens, and again each time the agent finishes before it closes. `unread` is BB's word for
 * the agent's thread, as the review's page last loaded it.
 */
export function useAgentRead(targetKey: string, unread: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  useEffect(() => {
    if (!unread) return;
    const read = () => { if (document.visibilityState === "visible") void rpc.call("readAgent", { targetKey }).catch(() => {}); };
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, [rpc, targetKey, unread]);
}
