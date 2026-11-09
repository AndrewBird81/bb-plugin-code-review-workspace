import { expect, test } from "vitest";
import type { CommentItem } from "./comments";
import { summaryLines } from "./summary-lines";

const files = ["pkg/hls/playlist.go", "pkg/hls/playlist_test.go", "src/a.ts", "src/read-me.md"];
const draft = (file: string, line: number, startLine?: number) => ({ kind: "draft", at: { file, line, side: "RIGHT", lines: `${line}` }, chapterId: "c1", comment: { file, line, side: "RIGHT", body: "x", ...startLine ? { startLine } : {} } }) as unknown as CommentItem;
const thread = (file: string, line: number) => ({ kind: "thread", at: { file, line, side: "RIGHT", lines: `${line}` }, chapterId: "c1", tag: "Nit" }) as unknown as CommentItem;

test("a cited line names its changed file, by its path or the only one it ends", () => {
  const lines = summaryLines("- `playlist.go:192` rejects `..`\n- `src/a.ts:4-6` too\n- `read-me.md:2-3`", files, []);
  expect(lines.map(({ file, line, cited }) => ({ file, line, cited }))).toEqual([
    { file: "pkg/hls/playlist.go", line: 192, cited: "playlist.go:192" },
    { file: "src/a.ts", line: 4, cited: "src/a.ts:4–6" },
    { file: "src/read-me.md", line: 2, cited: "read-me.md:2–3" },
  ]);
});

test("a line is cited once, and a file the PR doesn't change, a URL's port, or a moved comment's earlier diff isn't", () => {
  const body = "playlist.go:192 and playlist.go:192 again; lib/other.ts:3; https://example.com:443/x; On `src/a.ts:9` (an earlier diff): gone";
  expect(summaryLines(body, files, []).map((l) => l.cited)).toEqual(["playlist.go:192"]);
});

test("a path two changed files end isn't guessed at", () => {
  expect(summaryLines("a.ts:1", ["src/a.ts", "lib/a.ts"], [])).toEqual([]);
});

test("each line has the comment on it, a range's or one beside it; one no comment raises has none", () => {
  const items = [draft("pkg/hls/playlist.go", 192), draft("src/a.ts", 20, 15), thread("pkg/hls/playlist_test.go", 40)];
  const body = "playlist.go:193, playlist.go:159, src/a.ts:16, playlist_test.go:40";
  expect(summaryLines(body, files, items).map((l) => l.item)).toEqual([items[0], null, items[1], items[2]]);
});
