import { useEffect, useState } from "react";
import { experimental_usePluginId, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../src/rpc-contract";

/** Register before mounting editors; release only after the open request settles. */
export function useReviewSession() {
  const rpc = useRpc<typeof rpcContract>();
  // The install's own id, which isn't guided-review when installed under another.
  const pluginId = experimental_usePluginId();
  const [clientId, setClientId] = useState("");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let closed = false;
    const id = crypto.randomUUID();
    setClientId(id);
    setReady(false); setError("");
    const opened = rpc.call("setReviewPresence", { clientId: id, open: true });
    const pagehide = (event: PageTransitionEvent) => {
      // A cached page still owns its editors. A real reload/close releases the
      // lease using a small same-origin request that survives document unload.
      if (event.persisted) return;
      const url = `/api/v1/plugins/${pluginId}/rpc/setReviewPresence`;
      const body = JSON.stringify({ clientId: id, open: false });
      if (!navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) {
        void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true, credentials: "same-origin" }).catch(() => {});
      }
    };
    window.addEventListener("pagehide", pagehide);
    void opened.then(() => { if (!closed) setReady(true); }).catch(() => {
      if (!closed) setError("Couldn’t open the review session. The plugin may be updating. Try again.");
    });
    return () => {
      closed = true;
      window.removeEventListener("pagehide", pagehide);
      void opened.catch(() => {}).then(() => rpc.call("setReviewPresence", { clientId: id, open: false })).catch(() => {});
    };
  }, [rpc, pluginId, attempt]);
  return { clientId, ready, error, retry: () => setAttempt(value => value + 1) };
}
