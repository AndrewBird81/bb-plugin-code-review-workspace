import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { ReviewMeta } from "../src/store";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { TOUCH_CONTROL } from "./touch";

// The workspace's review has a guide already, so a guide that didn't run is its update for new commits; a tracked PR's
// page has Start review.
const RUN_LABEL = { guide: "Update guide", review: "Run review", check: "Run check" } as const;
const STARTED = { guide: "Guide update started", review: "Review started", check: "Check started" } as const;

/** The click that runs what didn't run on its own because of the PR's author; its notice says why (lib/trust.ts notRunReason). */
export function NotRunButton({ review }: { review: Pick<ReviewMeta, "targetKey"> & { skippedRun: NonNullable<ReviewMeta["skippedRun"]> } }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const result = await rpc.call("runSkipped", { targetKey: review.targetKey });
      // On success the review's realtime update clears the notice.
      if (!result.ok) toast.error(result.error ?? "Couldn’t start it. Try again.");
      else toast.success(STARTED[review.skippedRun.run]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t start it. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return <Button variant="outline" size="sm" className={`h-7 ${TOUCH_CONTROL}`} disabled={busy} onClick={() => void run()}><Icon name="Play" aria-hidden />{RUN_LABEL[review.skippedRun.run]}</Button>;
}
