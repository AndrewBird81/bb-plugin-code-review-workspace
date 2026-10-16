// What GitHub says now about whether a PR's author is trusted, for a start that can't wait for the sync's read.
import type { RunGh } from "./github/types";
import type { ReviewMeta } from "./store";
import { foreignHeadOwner } from "../lib/trust";

/** The PR fields authorTrust reads; the query must also read viewer{login}. */
export const AUTHOR_TRUST_FIELDS = "authorAssociation author{login} isCrossRepository headRepositoryOwner{login}";

export type AuthorTrust = Pick<ReviewMeta, "kind" | "ownPr" | "authorAssociation" | "foreignHeadOwner">;

/** The author's trust in a GraphQL read of the PR, by the sync's rules (src/turn-signals.ts); null for a partial read. */
export function authorTrust(pr: any, viewer: string | null | undefined): AuthorTrust | null {
  if (!viewer || !pr || typeof pr.isCrossRepository !== "boolean") return null;
  const author: string | null = pr.author?.login ?? null;
  return {
    kind: "pr", ownPr: !!author && author.toLowerCase() === viewer.toLowerCase(), authorAssociation: pr.authorAssociation ?? null,
    foreignHeadOwner: foreignHeadOwner(pr.isCrossRepository ? pr.headRepositoryOwner?.login ?? "" : null, author, viewer),
  };
}

/** Reads the author's trust for one PR; null when gh fails or the read is partial. */
export async function readAuthorTrust(run: RunGh, repo: string, number: number): Promise<AuthorTrust | null> {
  const [owner, name] = repo.split("/");
  const query = `query($owner:String!,$repo:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$repo){pullRequest(number:$number){${AUTHOR_TRUST_FIELDS}}}}`;
  try {
    const out = await run(["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `repo=${name}`, "-F", `number=${number}`]);
    if (out.code !== 0) return null;
    const json = JSON.parse(out.stdout);
    return authorTrust(json?.data?.repository?.pullRequest, json?.data?.viewer?.login);
  } catch {
    return null;
  }
}
