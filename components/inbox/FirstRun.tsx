import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../src/rpc-contract";
import { cn } from "../../lib/utils";
import { AccountBar } from "../AccountBar";
import { TOUCH_CONTROL } from "../touch";
import { Button } from "../ui/button";
import { Icon, type IconName } from "../ui/icon";
import { IconTile } from "../ui/icon-tile";

type Setup = { account: string | null; githubCli: boolean; agentAvailable: boolean | null; projectAvailable: boolean | null };
const SIGN_IN = "gh auth login --hostname github.com";

/** One thing a review needs: done, to do (with how), or unknown (null), with a control at its end (`action`). */
function Check({ ok, children, fix, action }: { ok: boolean | null; children: ReactNode; fix?: ReactNode; action?: ReactNode }) {
  const icon: IconName = ok === true ? "CircleCheck" : ok === false ? "AlertTriangle" : "CircleQuestion";
  return (
    <li className="flex min-w-0 items-start gap-2.5 py-1.5">
      <Icon name={icon} className={cn("mt-0.5 size-4 shrink-0", ok === true ? "text-diff-added" : ok === false ? "text-warning-text" : "text-muted-foreground")} aria-hidden />
      <span className="min-w-0 flex-1 space-y-1.5"><span className="block">{children}</span>{ok === false && fix}</span>
      {/* Its own height, not the row's. */}
      {action && <span className="-my-1.5 shrink-0">{action}</span>}
    </li>
  );
}

/**
 * With no reviews yet, in place of the sections: the find box as a paste box (`omnibox`), what a review needs and
 * whether it's there (GitHub CLI and its account on the BB server, a BB agent), and the ways to start one.
 */
export function FirstRun({ omnibox, syncing }: { omnibox: ReactNode; syncing: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const check = useCallback(async () => {
    setChecking(true);
    try { setSetup(await rpc.call("getSetupStatus", null)); setFailed(false); }
    catch { setFailed(true); }
    finally { setChecking(false); }
  }, [rpc]);
  useEffect(() => { void check(); }, [check]);
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast.success("Copied"); }
    catch { toast.error("Couldn’t copy. Select the command instead."); }
  }
  return (
    <div className="mx-auto w-full max-w-xl space-y-8 pt-2">
      {omnibox}
      <section aria-labelledby="first-run-title" className="space-y-4">
        <div className="flex flex-col items-center gap-3 text-center">
          <IconTile tone="primary" icon="GitPullRequest" className="size-10 rounded-xl" iconClassName="size-5" />
          <h2 id="first-run-title" className="text-base font-semibold text-foreground">Review your first pull request</h2>
        </div>
        <ul aria-label="What a review needs" className="rounded-xl border border-border px-4 py-2 text-sm">
          {failed && <Check ok={null}>Couldn’t check the setup.</Check>}
          {setup && <>
            <Check ok={setup.githubCli} fix={<span className="block text-xs text-muted-foreground">Install it on the machine running BB, then check again.</span>}>
              {setup.githubCli ? "GitHub CLI on the BB server" : "GitHub CLI isn’t on the BB server"}
            </Check>
            <Check ok={!!setup.account} action={setup.account && <AccountBar />} fix={<span className="flex flex-wrap items-center gap-2">
              <code className="break-all rounded-md border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px]">{SIGN_IN}</code>
              <Button variant="outline" size="sm" className={cn("h-7", TOUCH_CONTROL)} onClick={() => void copy(SIGN_IN)}>Copy</Button>
            </span>}>
              {setup.account ? `Signed in to GitHub as @${setup.account}` : "Sign in to GitHub on the BB server"}
            </Check>
            <Check ok={setup.agentAvailable} fix={<span className="block text-xs text-muted-foreground">Connect an agent provider in BB’s Settings.</span>}>
              {setup.agentAvailable === true ? "A BB agent to write guides" : setup.agentAvailable === false ? "No BB agent to write guides" : "Couldn’t check BB’s agent providers"}
            </Check>
            {setup.projectAvailable !== true && <Check ok={setup.projectAvailable} fix={<span className="block text-xs text-muted-foreground">Add a BB project before starting a review.</span>}>
              {setup.projectAvailable === false ? "No BB project to run guides in" : "Couldn’t check your BB projects"}
            </Check>}
          </>}
          {syncing && <li className="flex items-center gap-2.5 py-1.5 text-muted-foreground"><Icon name="Loading" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />Looking for PRs that request your review…</li>}
        </ul>
        {(failed || (setup && (!setup.githubCli || !setup.account || setup.agentAvailable !== true || setup.projectAvailable !== true))) &&
          <Button variant="outline" size="sm" disabled={checking} className={cn("mx-auto flex", TOUCH_CONTROL)} onClick={() => void check()}>{checking ? "Checking…" : "Check again"}</Button>}
        <div className="space-y-1.5 text-center text-sm text-muted-foreground">
          <p>Paste a PR link above, or run <code className="rounded-md border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-foreground">bb review &lt;pr&gt;</code> in any BB thread.</p>
          <p className="text-xs">Guides use your BB agent’s usual allowance. Nothing reaches GitHub until you submit, send a reply, or resolve a thread.</p>
        </div>
      </section>
    </div>
  );
}
