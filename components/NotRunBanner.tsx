import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../src/rpc-contract";
import type { ReviewMeta } from "../src/store";
import { notRunReason } from "../lib/trust";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

// The workspace's review has a guide already, so a guide that didn't run is a rebuild; a tracked PR's page has Start review.
const RUN_LABEL = { guide: "Re-review", review: "Run review", check: "Run check" } as const;

/** What didn't run on its own because of the PR's author, why, and the click that runs it. */
export function NotRunBanner({ review }: { review: Pick<ReviewMeta, "targetKey" | "author" | "repo" | "authorAssociation"> & { skippedRun: NonNullable<ReviewMeta["skippedRun"]> } }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const result = await rpc.call("runSkipped", { targetKey: review.targetKey });
      // On success the review's realtime update clears the banner.
      if (!result.ok) toast.error(result.error ?? "Couldn’t start it. Try again.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t start it. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <p role="status" aria-label="Not run automatically" className="flex flex-wrap items-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-1.5 text-xs text-warning-text">
      <Icon name="Lock" className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{notRunReason(review)}.</span>
      <Button variant="outline" size="sm" className="h-7" disabled={busy} onClick={() => void run()}><Icon name="Play" aria-hidden />{RUN_LABEL[review.skippedRun.run]}</Button>
    </p>
  );
}
