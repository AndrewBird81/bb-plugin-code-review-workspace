import { test, expect, vi } from "vitest";
import { parseGhAccounts, getGhAccounts, switchGhAccount, checkRepoAccess } from "./gh-accounts";

const STATUS_SAMPLE = `github.com
  ✓ Logged in to github.com account monalisa (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo'

  ✓ Logged in to github.com account octocat (keyring)
  - Active account: false
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo'
`;

test("parseGhAccounts extracts logins after 'account <login>', skipping 'Active account: true/false'", () => {
  expect(parseGhAccounts(STATUS_SAMPLE)).toEqual(["monalisa", "octocat"]);
});

test("parseGhAccounts dedups and preserves first-seen order", () => {
  const text = "account foo (keyring)\naccount bar (keyring)\naccount foo (keyring)";
  expect(parseGhAccounts(text)).toEqual(["foo", "bar"]);
});

test("parseGhAccounts returns [] on empty/unrelated text", () => {
  expect(parseGhAccounts("")).toEqual([]);
  expect(parseGhAccounts("Active account: true\nActive account: false")).toEqual([]);
});

test("getGhAccounts marks the active login and reads status from stdout+stderr", async () => {
  const runGh = vi.fn(async (args: string[]) => {
    if (args[0] === "api") return { stdout: "monalisa\n", stderr: "", code: 0 };
    if (args[0] === "auth") return { stdout: "", stderr: STATUS_SAMPLE, code: 0 };
    return { stdout: "", stderr: "", code: 1 };
  });

  const res = await getGhAccounts(runGh as any);

  expect(res.active).toBe("monalisa");
  expect(res.accounts).toEqual([
    { login: "monalisa", active: true },
    { login: "octocat", active: false },
  ]);
});

test("getGhAccounts returns active:null when the user lookup fails", async () => {
  const runGh = vi.fn(async (args: string[]) => {
    if (args[0] === "api") return { stdout: "", stderr: "not logged in", code: 1 };
    return { stdout: "", stderr: STATUS_SAMPLE, code: 0 };
  });

  const res = await getGhAccounts(runGh as any);

  expect(res.active).toBeNull();
  expect(res.accounts.every((a) => !a.active)).toBe(true);
});

test("switchGhAccount pins github.com and verifies the new active login", async () => {
  const runGh = vi.fn(async () => ({ stdout: "octocat\n", stderr: "", code: 0 }));

  const res = await switchGhAccount(runGh as any, "octocat");

  expect(runGh).toHaveBeenCalledWith(["auth", "switch", "--hostname", "github.com", "--user", "octocat"]);
  expect(res).toEqual({ ok: true, active: "octocat" });
});

test("switchGhAccount surfaces stderr on failure", async () => {
  const runGh = vi.fn(async () => ({ stdout: "", stderr: "no such user", code: 1 }));

  const res = await switchGhAccount(runGh as any, "ghost");

  expect(res.ok).toBe(false);
  expect(res.active).toBeNull();
  expect(res.error).toBe("no such user");
});

test("checkRepoAccess is accessible:true with no repo (nothing to check)", async () => {
  const runGh = vi.fn(async () => ({ stdout: "monalisa\n", stderr: "", code: 0 }));

  const res = await checkRepoAccess(runGh as any, null);

  expect(res).toEqual({ accessible: true, repo: null, account: "monalisa" });
});

test("checkRepoAccess reports accessible:false on a 404 (gh api failure)", async () => {
  const runGh = vi.fn(async (args: string[]) => {
    if (args[0] === "api" && args[1] === "user") return { stdout: "monalisa\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "HTTP 404: Not Found", code: 1 };
  });

  const res = await checkRepoAccess(runGh as any, "acme/private-repo");

  expect(res).toEqual({ accessible: false, repo: "acme/private-repo", account: "monalisa" });
});

// bug bash PRF-2: any gh failure read as no access, so with GitHub unreachable, rate-limited or gh missing, the review
// said your account couldn't access the repo, offering the account switcher.
const repoFails = (failure: { stdout?: string; stderr: string; code: number }) => async (args: string[]) =>
  args[1] === "user" ? { stdout: "monalisa\n", stderr: "", code: 0 } : { stdout: "", ...failure };

test.each([
  { stderr: "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n", code: 1 },
  { stdout: "{\"message\":\"API rate limit exceeded for user ID 1.\"}", stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)\n", code: 1 },
  { stderr: "gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)\n", code: 1 },
  { stderr: "gh: You have triggered an abuse detection mechanism. (HTTP 403)\n", code: 1 },
  { stderr: "gh: Too Many Requests (HTTP 429)\n", code: 1 },
  { stderr: "gh: Server Error (HTTP 502)\n", code: 1 },
  { stderr: "gh timed out after 120s", code: 124 },
  { stderr: "gh could not start: spawn gh ENOENT", code: 1 },
])("checkRepoAccess can't tell, and doesn't say no access, when GitHub doesn't answer for the repo ($stderr)", async (failure) => {
  const res = await checkRepoAccess(repoFails(failure), "acme/web");
  expect(res).toEqual({ accessible: true, repo: "acme/web", account: "monalisa", error: failure.stderr.trim() });
});

test.each([
  "gh: Not Found (HTTP 404)\n",
  "gh: Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization. (HTTP 403)\n",
  "gh: Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions. (HTTP 403)\n",
])("checkRepoAccess reports no access when GitHub refuses the account the repo (%s)", async (stderr) => {
  expect(await checkRepoAccess(repoFails({ stderr, code: 1 }), "acme/web")).toEqual({ accessible: false, repo: "acme/web", account: "monalisa" });
});

test("checkRepoAccess reports no access for credentials GitHub refuses, saying so", async () => {
  const run = async () => ({ stdout: "", stderr: "gh: Bad credentials (HTTP 401)\n", code: 1 });
  expect(await checkRepoAccess(run, "acme/web")).toEqual({ accessible: false, repo: "acme/web", account: null, badCredentials: true });
});

test("checkRepoAccess reports accessible:true when the repo lookup succeeds", async () => {
  const runGh = vi.fn(async (args: string[]) => {
    if (args[0] === "api" && args[1] === "user") return { stdout: "monalisa\n", stderr: "", code: 0 };
    return { stdout: "acme/web\n", stderr: "", code: 0 };
  });

  const res = await checkRepoAccess(runGh as any, "acme/web");

  expect(res).toEqual({ accessible: true, repo: "acme/web", account: "monalisa" });
});

test("environment-token accounts are shown even when not in the saved account list", async () => {
  const runGh = vi.fn(async (args: string[]) => ({ stdout: args[0] === "api" ? "ci-bot\n" : "", stderr: STATUS_SAMPLE, code: 0 }));
  const result = await getGhAccounts(runGh);
  expect(result.accounts[0]).toEqual({ login: "ci-bot", active: true });
  expect(runGh).toHaveBeenCalledWith(["auth", "status", "--hostname", "github.com"]);
});

test("a token override cannot falsely report a successful account switch", async () => {
  const runGh = vi.fn(async (args: string[]) => ({ stdout: args[0] === "api" ? "ci-bot\n" : "", stderr: "", code: 0 }));
  const result = await switchGhAccount(runGh, "octocat");
  expect(result).toMatchObject({ ok: false, active: "ci-bot" });
  expect(result.error).toContain("GH_TOKEN");
});
