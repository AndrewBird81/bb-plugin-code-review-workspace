// A folder on a machine, as bb's Git plugin (bb--git) and GitHub PR status plugin answer for it, for env-diff's tests.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

export const BASE_SHA = "6251243c81c5a15e87d84926eed350082ee54bb9";

export interface FolderFile {
  path: string;
  origin?: "tracked" | "untracked";
  binary?: boolean;
  /** Lines changed: past 500 bb loads the diff on demand, past 20,000 it's too large. */
  lines?: number;
  /** Its diff, without headers; bb cuts any past 512 KB. */
  body?: string;
  truncated?: boolean;
  /** Changed when listed, back as it was when its diff is read: git gives no diff. */
  reverted?: boolean;
  old?: string;
  new?: string;
  /** A symbolic link to this target; with `replaced`, a regular file that became one, as BB's Git plugin sends it: two blocks. */
  link?: string;
  replaced?: boolean;
}

const headers = (file: FolderFile): string => file.link !== undefined
  ? `${file.replaced ? `diff --git a/${file.path} b/${file.path}\ndeleted file mode 100644\nindex 11375b33..00000000\n--- a/${file.path}\n+++ /dev/null\n@@ -1 +0,0 @@\n-# Readme\n` : ""}`
    + `diff --git a/${file.path} b/${file.path}\nnew file mode 120000\nindex 00000000..557bd922\n--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1 @@\n+${file.link}\n\\ No newline at end of file\n`
  : file.binary
  ? `diff --git a/${file.path} b/${file.path}\nnew file mode 100644\nindex 0000000..1111111\nGIT binary patch\nliteral 4\nLcmZ?wbYuVk0Db@\n\nliteral 0\nHcmV?d00001\n`
  : `diff --git a/${file.path} b/${file.path}\nindex 1111111..2222222 100644\n--- a/${file.path}\n+++ b/${file.path}\n${file.body ?? "@@ -1 +1 @@\n-a\n+b\n"}`;

export interface Folder {
  files: FolderFile[];
  env?: Partial<{ mergeBaseBranch: string | null; baseBranch: string | null; defaultBranch: string | null; status: string; branchName: string | null; path: string; projectId: string }>;
  prBase?: string;
  /** With prBase, the rest of the PR GitHub PR status reports. */
  pr?: { number: number; url: string; headRefName: string; state?: string };
  /** What GitHub PR status says instead, or that it throws. */
  prLookup?: "unavailable" | "throws";
  connected?: boolean;
  /** bb lists at most this many files. */
  listLimit?: number;
  /** The Git plugin throws, as when it can't reach the machine. */
  throws?: string;
  /** What the Git plugin says instead of a file list. */
  filesFailure?: unknown;
  missing?: boolean;
  /** The Git plugin's answer to a method instead of the folder's, as a changed or broken plugin might give. */
  answers?: Record<string, (input: any) => unknown>;
}

/**
 * A fake plugin host whose environment `env1` is `folder`, on MaxBook; `calls` records each Git plugin call. `sdk` adds
 * other areas, such as threads, or another environment's answers through `environments`.
 */
export function folderHost(folder: Folder, sdk: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; input: any }> = [];
  const revision = (file: FolderFile) => file.link !== undefined ? `${file.replaced ? "100644" : "000000"}:${file.path.length}:120000:${file.link.length}`
    : `100644:${file.path.length}:100644:${(file.body ?? "").length}`;
  const git: Record<string, (input: any) => unknown> = {
    files: (input) => {
      if (folder.filesFailure) return folder.filesFailure;
      const listed = folder.files.slice(0, folder.listLimit ?? 500);
      const entries = listed.map((file) => {
        const lines = file.lines ?? 2;
        return {
          path: file.path, previousPath: null, changeKind: file.origin === "untracked" ? "added" : "modified", additions: lines, deletions: 0,
          binary: !!file.binary, origin: file.origin ?? "tracked", loadMode: lines > 20_000 ? "too_large" : file.binary || lines > 500 ? "on_demand" : "auto",
          revision: revision(file),
        };
      });
      const auto = entries.length > 10 ? [] : entries.filter((entry) => entry.loadMode === "auto");
      return {
        outcome: "available", files: entries, truncated: listed.length < folder.files.length, shortstat: "",
        mergeBaseRef: /^[0-9a-f]{40}$/.test(input.target.mergeBaseBranch) ? input.target.mergeBaseBranch : BASE_SHA,
        initialPatches: auto.map((entry) => ({ path: entry.path, patch: headers(folder.files.find((f) => f.path === entry.path)!), truncated: false })),
      };
    },
    patches: ({ keys }) => Object.fromEntries((keys as string[]).map((key) => {
      const [, , , path] = JSON.parse(key);
      const file = folder.files.find((f) => f.path === path)!;
      return [key, { outcome: "available", patch: { path, patch: file.reverted ? "" : headers(file), truncated: !!file.truncated } }];
    })),
    fileSide: ({ query }) => {
      const file = folder.files.find((f) => f.path === query.path);
      const text = file?.[query.side as "old" | "new"];
      // As bb does: a file the folder has but the commit hasn't fails with git's words.
      if (text === undefined && query.side === "old" && file?.new !== undefined) {
        throw new Error(`handler_error: HTTP 500: HTTP 502: git cat-file -t ${query.mergeBaseRef}:${query.path} failed: fatal: path '${query.path}' exists on disk, but not in '${query.mergeBaseRef}'`);
      }
      if (text === undefined) return { outcome: "unavailable", code: "ENOENT", message: "Path does not exist" };
      return { outcome: "available", file: { path: query.path, content: text, contentEncoding: file!.binary ? "base64" : "utf8", sizeBytes: text.length } };
    },
  };
  const { bb, harness } = createFakePluginHost({ pluginId: "code-review-workspace", sdk: {
    environments: {
      get: async ({ environmentId }: { environmentId: string }) => {
        if (folder.missing) throw Object.assign(new Error("HTTP 404: Environment not found"), { status: 404 });
        return { id: environmentId, hostId: "host_max", path: "/Users/me/src/api", status: "ready", isGitRepo: true, branchName: "feat/qa",
          mergeBaseBranch: null, baseBranch: null, defaultBranch: "main", projectId: "proj_api", ...folder.env };
      },
    },
    projects: { get: async () => ({ id: "proj_api", gitRemoteUrl: "git@github.com:acme/api.git" }), list: async () => [{ id: "proj_api", kind: "standard", gitRemoteUrl: "git@github.com:acme/api.git" }] },
    ...sdk,
    hosts: { get: async () => ({ id: "host_max", name: "MaxBook", status: folder.connected === false ? "disconnected" : "connected", lifecycle: { phase: "active" } }) },
    plugins: {
      callRpc: async ({ pluginId, method, input, outputSchema }: any) => {
        if (pluginId === "bb--github-pr-status") {
          if (folder.prLookup === "throws") throw new Error("bb--github-pr-status isn't running");
          if (folder.prLookup) return outputSchema.parse({ [input.keys[0]]: { outcome: "unavailable", message: "gh: HTTP 502" } });
          return outputSchema.parse({ [input.keys[0]]: folder.prBase ? { outcome: "available", pullRequest: { number: 7, baseRefName: folder.prBase, ...folder.pr } } : { outcome: "absent" } });
        }
        if (pluginId !== "bb--git") throw new Error(`${pluginId} isn't installed`);
        calls.push({ method, input });
        if (folder.throws) throw new Error(folder.throws);
        return outputSchema.parse((folder.answers?.[method] ?? git[method]!)(input));
      },
    },
  } as any });
  return { bb, harness, calls };
}
