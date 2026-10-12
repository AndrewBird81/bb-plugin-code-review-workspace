import { useReviewSession } from "../lib/review-session";
import { Button } from "./ui/button";
import { Inbox } from "./inbox/Inbox";
import { ReviewSettingsPage } from "./ReviewSettings";
import { ReviewWorkspace } from "./ReviewWorkspace";

// NOTE: not wrapped in memo() — the plugin SDK's slot registration requires
// `component` to be a plain function (`typeof value === "function"`); a
// memo()-wrapped component is an object and is rejected both by the testing
// harness and by the production plugin-app-collector.
export function ReviewPanel({ subPath }: { subPath: string }) {
  const targetKey = subPath.split("/")[0] ?? "";
  if (targetKey === "settings") return <ReviewSettingsPage returnTo={subPath.split("/").slice(1).join("/")} />;
  return <ReviewSession key={targetKey} targetKey={targetKey} />;
}
ReviewPanel.displayName = "ReviewPanel";

function ReviewSession({ targetKey }: { targetKey: string }) {
  const session = useReviewSession();
  if (!session.ready) return <div className="space-y-3 p-6"><p role={session.error ? "alert" : "status"}>{session.error || "Opening review…"}</p>{session.error && <Button onClick={session.retry}>Try again</Button>}</div>;
  return targetKey ? <ReviewWorkspace targetKey={targetKey} /> : <Inbox />;
}
