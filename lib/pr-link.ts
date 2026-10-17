// A GitHub pull request as people paste it: a link to any of its pages, or owner/repo#n. bb review takes both; the
// inbox sends owner/repo#n on as a link.

/** A link to any page of a PR: /changes, /files/<range>, /commits/<sha>, and so on. An owner may hold _, as an Enterprise Managed User's does. */
const PR_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)(?:\/[^?#]*)?(?:[?#].*)?$/i;
const PR_REFERENCE = /^([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)#([1-9]\d*)$/;

export interface PrLink {
  /** owner/repo, lowercase, as reviews store it. */
  repo: string;
  number: number;
  /** The PR's link, which starting a review takes. */
  url: string;
  /** How it reads: acme/web#42. */
  name: string;
}

/** The PR a pasted link or owner/repo#n names; null for anything else, such as words to find a review by. */
export function parsePrLink(input: string): PrLink | null {
  const text = input.trim();
  const match = text.match(PR_URL) ?? text.match(PR_REFERENCE);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  const repo = match[1].toLowerCase();
  const number = Number(match[2]);
  return { repo, number, url: `https://github.com/${repo}/pull/${number}`, name: `${repo}#${number}` };
}
