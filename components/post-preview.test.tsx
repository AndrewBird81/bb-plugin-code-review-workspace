// @vitest-environment jsdom
// The review agent's Post form, in place of its message box: where it posts and as whom, exactly what posts, and one Post.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PostShown } from "../src/post-preview";

afterEach(cleanup);

const shown: PostShown = {
  title: "Post to web#42 as @casey", action: "Approve", button: "Post",
  parts: [{ label: "Summary", body: "Ship it.\n\n<!-- hidden -->" }, { label: "src/a.ts:12", body: "**Nit:** Rename this.", path: true }],
  notes: ["The PR has new commits since you reviewed it. Submitting anyway posts on the version you reviewed."],
};

async function renderForm(payload: unknown = shown, submit = vi.fn(async () => {}), cancel = vi.fn(async () => {})) {
  const app = await loadPluginApp(() => import("../app"));
  const registration = app.pendingInteractions.find((form) => form.id === "post-preview")!;
  const slot = renderSlot(registration, { interaction: { id: "i1", threadId: "agent", title: "Post to web#42 as @casey", payload: payload as any, createdAt: 1, expiresAt: null }, submit, cancel });
  return { slot, submit, cancel };
}

test("it says where it posts and as whom, then shows exactly what posts, as written, with one Post button", async () => {
  const { slot, submit } = await renderForm();
  const form = slot.getByRole("region", { name: "Post to web#42 as @casey" });
  // Drawn in BB's composer, outside the plugin's mount, it carries the plugin's style scope itself.
  expect(form.hasAttribute("data-bb-plugin-root")).toBe(true);
  expect(form.textContent).toContain("Approve");
  expect(slot.getByText(shown.notes[0])).toBeTruthy();
  // Raw, so nothing in it hides: a comment GitHub wouldn't render shows here.
  expect(slot.getByText((_, el) => el?.tagName === "P" && el.textContent === "Ship it.\n\n<!-- hidden -->")).toBeTruthy();
  expect(slot.getByText("**Nit:** Rename this.")).toBeTruthy();
  expect(slot.getByText("src/a.ts:12")).toBeTruthy();
  const buttons = slot.getAllByRole("button");
  expect(buttons.map((b) => b.textContent)).toEqual(["Don’t post", "Post"]);
  fireEvent.click(slot.getByRole("button", { name: "Post" }));
  expect(submit).toHaveBeenCalledWith({ post: true });
  await waitFor(() => expect(slot.getByRole("button", { name: "Posting…" }).getAttribute("aria-disabled")).toBe("true"));
  // A second click while it posts does nothing.
  fireEvent.click(slot.getByRole("button", { name: "Posting…" }));
  expect(submit).toHaveBeenCalledTimes(1);
});

test("a merge says how it's done, its button says Merge, and Don't merge closes it without merging", async () => {
  const { slot, submit, cancel } = await renderForm({ ...shown, title: "Merge web#42 as @casey", action: "Merge", button: "Merge", parts: [], notes: [], details: ["Squashed into one commit, at abc1234, the commit you reviewed."] });
  expect(slot.queryByText("Exactly what posts:")).toBeNull();
  expect(slot.getByRole("button", { name: "Merge" })).toBeTruthy();
  expect(slot.getByText("Squashed into one commit, at abc1234, the commit you reviewed.")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Don’t merge" }));
  expect(cancel).toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

test("a payload it can't read offers no Post, only closing it", async () => {
  const { slot } = await renderForm({ nope: true });
  expect(slot.queryByRole("button", { name: "Post" })).toBeNull();
  expect(slot.getByText(/couldn't be read/)).toBeTruthy();
});

test("a Post that fails says why and can be tried again", async () => {
  const submit = vi.fn().mockRejectedValueOnce(new Error("The form expired.")).mockResolvedValue(undefined);
  const { slot } = await renderForm(shown, submit);
  fireEvent.click(slot.getByRole("button", { name: "Post" }));
  expect((await slot.findByRole("alert")).textContent).toBe("The form expired.");
  fireEvent.click(slot.getByRole("button", { name: "Post" }));
  expect(submit).toHaveBeenCalledTimes(2);
});

test("an approval is unmistakable: led by Approve, in the success tone, its button Approve; only paths are monospace", async () => {
  const { slot, submit } = await renderForm({ ...shown, title: "Approve flosports/api#42 as @casey", action: "Approve", button: "Approve", parts: [{ label: "Summary", body: "Ship it." }, { label: "src/a.ts:12", body: "Nit.", path: true }] });
  expect(slot.getByRole("region", { name: "Approve flosports/api#42 as @casey" })).toBeTruthy();
  expect(slot.getByText("Approve", { selector: "span" }).className).toContain("text-diff-added");
  expect(slot.getByText("Summary").className).not.toContain("font-mono");
  expect(slot.getByText("src/a.ts:12").className).toContain("font-mono");
  expect(slot.getAllByRole("button").map((b) => b.textContent)).toEqual(["Don’t approve", "Approve"]);
  fireEvent.click(slot.getByRole("button", { name: "Approve" }));
  expect(submit).toHaveBeenCalledWith({ post: true });
});

test("Request changes and Close name what they do, on both buttons", async () => {
  const rc = await renderForm({ ...shown, title: "Request changes on flosports/api#42 as @casey", action: "Request changes", button: "Request changes", notes: [] });
  expect(rc.slot.getAllByRole("button").map((b) => b.textContent)).toEqual(["Don’t request changes", "Request changes"]);
  cleanup();
  const close = await renderForm({ ...shown, title: "Close flosports/api#42 as @casey", action: "Close", button: "Close", parts: [], notes: [], details: ["Closes the PR without merging it."] });
  expect(close.slot.getAllByRole("button").map((b) => b.textContent)).toEqual(["Don’t close", "Close"]);
});

test("Open PR shows its title and description, base ← head, and as whom, and its button says Open PR", async () => {
  const { slot, submit } = await renderForm({ title: "Open a PR from feat/qa into main as @casey", action: "Open PR", button: "Open PR", notes: [],
    parts: [{ label: "Title", body: "Snooze flaky checks" }, { label: "Description", body: "Adds a snooze." }], details: ["acme/api: main ← feat/qa, at c0ffee0 on GitHub."] });
  expect(slot.getByRole("region", { name: "Open a PR from feat/qa into main as @casey" })).toBeTruthy();
  expect(slot.getByText("acme/api: main ← feat/qa, at c0ffee0 on GitHub.")).toBeTruthy();
  expect(slot.getByText("Snooze flaky checks")).toBeTruthy();
  expect(slot.getByText("Adds a snooze.")).toBeTruthy();
  expect(slot.getAllByRole("button").map((b) => b.textContent)).toEqual(["Don’t open", "Open PR"]);
  fireEvent.click(slot.getByRole("button", { name: "Open PR" }));
  expect(submit).toHaveBeenCalledWith({ post: true });
  expect(await slot.findByRole("button", { name: "Opening…" })).toBeTruthy();
});
