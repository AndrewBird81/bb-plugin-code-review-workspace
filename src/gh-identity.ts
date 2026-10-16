import type { runGh } from "./gh";

/** What a write says it was doing, and what it kept, when the account can't be used. */
export interface GhWrite { doing: string; kept: string }
const SUBMITTING: GhWrite = { doing: "submitting", kept: " Your draft has been kept." };

/** Capture a credential for one write, so a concurrent `gh auth switch`
 * cannot change the author between checking the PR and posting the review.
 * Credentials stay in this server-side closure and never enter RPC or logs. */
export async function bindGhAccount(run: typeof runGh, login: string, write: GhWrite = SUBMITTING): Promise<typeof runGh> {
  if (!/^[A-Za-z0-9-]+$/.test(login)) throw new Error(`Verify your GitHub account before ${write.doing}.`);
  const token = await run(["auth", "token", "--hostname", "github.com", "--user", login]);
  if (token.code !== 0 || !token.stdout.trim()) throw new Error(`Couldn't use this GitHub account. Check authentication on the BB server and try again.${write.kept}`);
  const authToken = token.stdout.trim();
  const bound: typeof runGh = (args, opts) => run(args, { ...opts, authToken });
  const identity = await bound(["api", "user", "--jq", ".login"]);
  if (identity.code !== 0 || identity.stdout.trim().toLowerCase() !== login.toLowerCase()) {
    throw new Error(`The GitHub account changed. Reload the review and verify the account before ${write.doing}.${write.kept}`);
  }
  return bound;
}
