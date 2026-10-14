import { expect, test } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "./store";
import { defaultPreferences, readPreferences } from "./preferences";
import { mayRunChecks, mayRunUnattended, notRunReason, trustedAuthor } from "../lib/trust";
import type { ReviewMeta } from "./store";

const pr = (extra: Partial<ReviewMeta> = {}): ReviewMeta => ({ targetKey: "pr-1", kind: "pr", repo: "acme/web", number: 1, author: "mallory", headSha: "sha1", status: "ready", createdAt: 1, ...extra });

test("settings saved before trust existed keep agents to members and collaborators, and the repo's checks off", () => {
  const { bb } = createFakePluginHost({ pluginId: "guided-review" });
  const store = createStore(bb);
  const { unattendedAuthors: _authors, runRepoChecks: _checks, ...older } = defaultPreferences;
  bb.storage.database().prepare(`INSERT INTO review_preferences (id,value,revision) VALUES (1,?,1)`).run(JSON.stringify({ ...older, diffLayout: "unified" }));
  expect(store.getPreferences().preferences).toMatchObject({ unattendedAuthors: "members", runRepoChecks: false, diffLayout: "unified" });
  expect(readPreferences({})).toMatchObject({ unattendedAuthors: "members", runRepoChecks: false });
});

test("owners, members, and collaborators are trusted; others only with the setting at anyone", () => {
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) expect(trustedAuthor(pr({ authorAssociation: association }), defaultPreferences)).toBe(true);
  for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", null, undefined]) {
    expect(trustedAuthor(pr({ authorAssociation: association }), defaultPreferences)).toBe(false);
    expect(trustedAuthor(pr({ authorAssociation: association }), { ...defaultPreferences, unattendedAuthors: "anyone" })).toBe(true);
  }
});

test("your own PRs and local reviews are trusted", () => {
  expect(trustedAuthor(pr({ authorAssociation: "NONE", ownPr: true }), defaultPreferences)).toBe(true);
  const local: ReviewMeta = { targetKey: "ref-1", kind: "ref", gitRef: "main...feature", status: "ready", createdAt: 1 };
  expect(trustedAuthor(local, defaultPreferences)).toBe(true);
});

test("an approved head runs unattended; another head doesn't", () => {
  const review = pr({ authorAssociation: "FIRST_TIME_CONTRIBUTOR", approvedHead: "sha1" });
  expect(mayRunUnattended(review, defaultPreferences, "sha1")).toBe(true);
  expect(mayRunUnattended(review, defaultPreferences, "sha2")).toBe(false);
  expect(mayRunUnattended(pr({ authorAssociation: "FIRST_TIME_CONTRIBUTOR" }), defaultPreferences, null)).toBe(false);
  expect(mayRunUnattended(pr({ authorAssociation: "MEMBER" }), defaultPreferences, "sha2")).toBe(true);
});

test("the repo's checks run only when turned on, on a trusted author's PR; approving a head never allows them", () => {
  const on = { ...defaultPreferences, runRepoChecks: true };
  expect(mayRunChecks(pr({ authorAssociation: "MEMBER" }), defaultPreferences)).toBe(false);
  expect(mayRunChecks(pr({ authorAssociation: "MEMBER" }), on)).toBe(true);
  expect(mayRunChecks(pr({ authorAssociation: "NONE", ownPr: true }), on)).toBe(true);
  expect(mayRunChecks(pr({ authorAssociation: "FIRST_TIME_CONTRIBUTOR", approvedHead: "sha1" }), on)).toBe(false);
  expect(mayRunChecks(pr({ authorAssociation: "FIRST_TIME_CONTRIBUTOR" }), { ...on, unattendedAuthors: "anyone" })).toBe(true);
});

test("a head branch in someone else's fork isn't trusted, even on a member's or your own PR, unless the setting is anyone", () => {
  const on = { ...defaultPreferences, runRepoChecks: true };
  for (const owner of ["mallory", ""]) for (const review of [pr({ authorAssociation: "MEMBER", foreignHeadOwner: owner }), pr({ authorAssociation: "NONE", ownPr: true, foreignHeadOwner: owner })]) {
    expect(trustedAuthor(review, defaultPreferences)).toBe(false);
    expect(mayRunChecks(review, on)).toBe(false);
    expect(mayRunUnattended(review, defaultPreferences, "sha1")).toBe(false);
    expect(mayRunUnattended({ ...review, approvedHead: "sha1" }, defaultPreferences, "sha1")).toBe(true);
    expect(mayRunChecks({ ...review, approvedHead: "sha1" }, on)).toBe(false);
    expect(trustedAuthor(review, { ...defaultPreferences, unattendedAuthors: "anyone" })).toBe(true);
  }
  expect(trustedAuthor(pr({ authorAssociation: "MEMBER", foreignHeadOwner: null }), defaultPreferences)).toBe(true);
  expect(notRunReason(pr({ authorAssociation: "MEMBER", foreignHeadOwner: "mallory" }))).toBe("Not run automatically: this PR’s branch is in @mallory’s fork");
  expect(notRunReason(pr({ authorAssociation: "MEMBER", foreignHeadOwner: "" }))).toBe("Not run automatically: this PR’s branch is in someone else’s fork");
});

test("the reason names the author and the repository's owner", () => {
  expect(notRunReason(pr({ authorAssociation: "NONE" }))).toBe("Not run automatically: @mallory isn’t a member of acme");
  expect(notRunReason(pr({ authorAssociation: null, author: undefined }))).toBe("Not run automatically: the author isn’t a member of acme");
});

test("before the sync read who wrote the PR, the reason says so, even once it reads a member", () => {
  expect(notRunReason(pr())).toBe("Not run automatically: GitHub hadn’t said who wrote this PR yet");
  expect(notRunReason(pr({ authorAssociation: "MEMBER" }))).toBe("Not run automatically: GitHub hadn’t said who wrote this PR yet");
  expect(trustedAuthor(pr(), defaultPreferences)).toBe(false);
});
