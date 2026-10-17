import { expect, test } from "vitest";
import { parsePrLink } from "./pr-link";

test("a link to any page of a PR, or owner/repo#n, names the PR", () => {
  const pr = { repo: "acme/web", number: 42, url: "https://github.com/acme/web/pull/42", name: "acme/web#42" };
  for (const input of [
    "https://github.com/acme/web/pull/42",
    "  https://github.com/Acme/Web/pull/42/files?w=1  ",
    "github.com/acme/web/pull/42/commits/abc123",
    "http://www.github.com/acme/web/pull/42#discussion_r1",
    "acme/web#42",
    "Acme/Web#42",
  ]) expect(parsePrLink(input)).toEqual(pr);
  expect(parsePrLink("acme/web.js#7")).toEqual({ repo: "acme/web.js", number: 7, url: "https://github.com/acme/web.js/pull/7", name: "acme/web.js#7" });
  // An Enterprise Managed User's owner holds _ (bug bash FUZ-7).
  for (const input of ["https://github.com/jdoe_acme/web/pull/7", "jdoe_acme/web#7"]) {
    expect(parsePrLink(input)).toEqual({ repo: "jdoe_acme/web", number: 7, url: "https://github.com/jdoe_acme/web/pull/7", name: "jdoe_acme/web#7" });
  }
});

test("words to find a review by, or anything else, aren't a PR", () => {
  for (const input of ["", "cache", "acme/web", "#42", "42", "acme/web#0", "acme/web # 42", "acme/web#42 cache", "https://github.com/acme/web/issues/42", "https://evilgithub.com/acme/web/pull/7", "https://github.com/acme/web/pull/7oops"]) {
    expect(parsePrLink(input)).toBeNull();
  }
});
