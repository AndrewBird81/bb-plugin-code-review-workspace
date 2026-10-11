import { test, expect } from "vitest";
import { parseChecks, parseReviewThreads } from "./threads";

test("parseChecks on empty array returns none", () => {
  expect(parseChecks("[]")).toEqual({ bucket: "none", checks: [] });
});

test("parseChecks on invalid json returns none", () => {
  expect(parseChecks("not json")).toEqual({ bucket: "none", checks: [] });
});

test("parseChecks with a fail bucket present returns fail", () => {
  const raw = JSON.stringify([
    { name: "lint", state: "SUCCESS", bucket: "pass", link: "https://x/1" },
    { name: "test", state: "FAILURE", bucket: "fail", link: "https://x/2" },
  ]);
  const result = parseChecks(raw);
  expect(result.bucket).toBe("fail");
  expect(result.checks).toEqual([
    { name: "lint", state: "SUCCESS", bucket: "pass", link: "https://x/1" },
    { name: "test", state: "FAILURE", bucket: "fail", link: "https://x/2" },
  ]);
});

test("parseChecks with all pass returns pass", () => {
  const raw = JSON.stringify([
    { name: "lint", state: "SUCCESS", bucket: "pass", link: "https://x/1" },
    { name: "build", state: "SUCCESS", bucket: "pass", link: "https://x/2" },
  ]);
  expect(parseChecks(raw).bucket).toBe("pass");
});

test("parseChecks with a pending bucket and no fail returns pending", () => {
  const raw = JSON.stringify([
    { name: "lint", state: "SUCCESS", bucket: "pass", link: "https://x/1" },
    { name: "deploy", state: "PENDING", bucket: "pending", link: "https://x/2" },
  ]);
  expect(parseChecks(raw).bucket).toBe("pending");
});

test("parseChecks with only skipping/cancel buckets returns none, not pass", () => {
  const raw = JSON.stringify([
    { name: "optional-lint", state: "SKIPPED", bucket: "skipping", link: "https://x/1" },
    { name: "manual-approval", state: "CANCELLED", bucket: "cancel", link: "https://x/2" },
  ]);
  expect(parseChecks(raw).bucket).toBe("none");
});

test("parseReviewThreads flattens a realistic graphql response", () => {
  const raw = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                id: "PRRT_1",
                isResolved: false,
                isOutdated: false,
                path: "src/foo.ts",
                line: 42,
                diffSide: "LEFT",
                comments: {
                  nodes: [
                    { id: "PRRC_1", databaseId: 111, author: { login: "alice" }, body: "please fix" },
                    { id: "PRRC_2", databaseId: 112, author: { login: "bob" }, body: "done" },
                  ],
                },
              },
              {
                id: "PRRT_2",
                isResolved: true,
                isOutdated: true,
                path: null,
                line: null,
                comments: { nodes: [] },
              },
            ],
          },
        },
      },
    },
  });

  expect(parseReviewThreads(raw)).toEqual({
    threads: [
      {
        id: "PRRT_1",
        isResolved: false,
        isOutdated: false,
        path: "src/foo.ts",
        line: 42,
        side: "LEFT",
        comments: [
          { id: "PRRC_1", databaseId: 111, author: "alice", body: "please fix" },
          { id: "PRRC_2", databaseId: 112, author: "bob", body: "done" },
        ],
      },
      {
        id: "PRRT_2",
        isResolved: true,
        isOutdated: true,
        path: null,
        line: null,
        side: "RIGHT",
        comments: [],
      },
    ],
  });
});

test("parseReviewThreads on invalid json returns empty threads", () => {
  expect(parseReviewThreads("not json")).toEqual({ threads: [] });
});
