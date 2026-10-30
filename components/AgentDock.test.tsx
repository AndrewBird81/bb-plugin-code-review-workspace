// @vitest-environment jsdom
import { useState } from "react";
import { test, expect, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { DockInjection } from "./AgentDock";
import { findPicker } from "./provider-picker.test-support";

installTestPluginRuntime();
afterEach(cleanup);
beforeEach(async () => { localStorage.clear(); (await import("./AgentDock")).forgetAgentDrafts(); });

const patch = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1,3 +1,4 @@", " a", "-b", "+b2", "+c", " d", ""].join("\n");
const codex = { providerId: "codex", model: "gpt-6-astra", reasoningLevel: "low", serviceTier: "default" };
const unstarted = () => ({ threadId: null, legacy: [], defaults: codex });

// Each ask is taken once per review, whichever dock takes it: every test's are new.
let nonce = 0;

/** Renders the dock with a way to send it selections, as the review workspace does; `asked`, one made before it mounts. */
async function renderDock(props: Record<string, unknown>, rpc: Record<string, any>, options: Record<string, unknown> = {}, asked?: DockInjection) {
  const { AgentDock } = await import("./AgentDock");
  let setInjection!: (injection: DockInjection) => void;
  function Workspace(props: any) {
    const [injection, set] = useState<DockInjection | undefined>(asked);
    setInjection = set;
    return <AgentDock {...props} injection={injection} />;
  }
  const slot = renderSlot({ component: Workspace }, { targetKey: "pr-1", patch, ...props }, { rpc, ...options });
  return { slot, inject: (context: DockInjection["context"], quote?: string) => act(() => setInjection({ context, nonce: ++nonce, ...(quote ? { quote } : {}) })) };
}

test("the agent starts on its first message, under a heading, with no widget to pop out or ✕ of its own: BB's panel has one", async () => {
  await renderDock({}, { getConversation: unstarted });
  await screen.findByText("Ask about this change.");
  expect(within(screen.getByRole("region", { name: "Review agent" })).getByRole("heading", { level: 2, name: "Review agent" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("button", { name: "Pop out" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Close/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
});

test("the first message starts the conversation on the chosen agent, then bb's chat takes over", async () => {
  const startConversation = vi.fn(async () => ({ threadId: "th-1" }));
  await renderDock({}, { getConversation: unstarted, startConversation });
  const picker = await findPicker(screen);
  expect((within(picker).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("gpt-6-astra");
  fireEvent.change(within(picker).getByRole("textbox", { name: "Model" }), { target: { value: "gpt-6" } });
  fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Ask the agent" }), { target: { value: "Is this safe?" } });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Ask the agent" }), { key: "Enter" });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Ask the agent" }), { key: "Enter" });
  const chat = await screen.findByTestId("bb-thread-chat");
  expect(chat.dataset).toMatchObject({ threadId: "th-1", variant: "compact", permissionPolicy: "inherit" });
  expect(startConversation).toHaveBeenCalledExactlyOnceWith({ targetKey: "pr-1", text: "Is this safe?", typed: "Is this safe?", inserted: false, agent: { ...codex, model: "gpt-6" } });
  expect(screen.queryByRole("textbox", { name: "Ask the agent" })).toBeNull();
  expect(screen.getByRole("button", { name: "New conversation" })).toBeTruthy();
});

test("Enter that confirms an IME conversion in Safari doesn't send the message", async () => {
  const startConversation = vi.fn(async () => ({ threadId: "th-1" }));
  await renderDock({}, { getConversation: unstarted, startConversation });
  const box = await screen.findByRole("textbox", { name: "Ask the agent" });
  fireEvent.change(box, { target: { value: "東京" } });
  // Safari has already cleared isComposing on the key that confirms the conversion.
  fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
  expect(startConversation).not.toHaveBeenCalled();
});

test("a selection becomes the first message's quoted context", async () => {
  const startConversation = vi.fn(async () => ({ threadId: "th-1" }));
  const { inject } = await renderDock({}, { getConversation: unstarted, startConversation });
  await screen.findByText("Ask about this change.");
  inject({ file: "x.ts", startLine: 2, endLine: 3, side: "additions" });
  expect(screen.getByText("x.ts:2–3")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Ask the agent" }), { target: { value: "Why?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByTestId("bb-thread-chat");
  expect(startConversation).toHaveBeenCalledWith({ targetKey: "pr-1", text: "Why?\n\nIn `x.ts` lines 2-3:\n```diff\n+b2\n+c\n```", typed: "Why?", inserted: true, agent: codex });
});

test("during a conversation, a selection is quoted into bb's composer for the reviewer to finish, noted first so it confirms no post", async () => {
  const noteInserted = vi.fn(async () => ({ ok: true }));
  const { slot, inject } = await renderDock({}, { getConversation: () => ({ threadId: "th-1", legacy: [], defaults: null }), noteInserted }, { composer: { scope: { kind: "thread", threadId: "th-1" } } });
  await screen.findByTestId("bb-thread-chat");
  inject({ file: "x.ts", code: "const x = 1" });
  await waitFor(() => expect(slot.inspection.composer.text).toContain("In `x.ts`:\n```\nconst x = 1\n```"));
  expect(noteInserted).toHaveBeenCalledExactlyOnceWith({ targetKey: "pr-1", threadId: "th-1", text: "In `x.ts`:\n```\nconst x = 1\n```" });
  await waitFor(() => expect(slot.inspection.composer.focusCount).toBe(1));
  expect(screen.queryByRole("textbox", { name: "Ask the agent" })).toBeNull();
});

test("a quote that couldn't be noted isn't put in bb's composer", async () => {
  const noteInserted = vi.fn(async () => { throw new Error("offline"); });
  const { slot, inject } = await renderDock({}, { getConversation: () => ({ threadId: "th-1", legacy: [], defaults: null }), noteInserted }, { composer: { scope: { kind: "thread", threadId: "th-1" } } });
  await screen.findByTestId("bb-thread-chat");
  inject({ file: "x.ts", code: "const x = 1" });
  await waitFor(() => expect(noteInserted).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(slot.inspection.composer.text).toBe("");
});

test("a quote put in the first message's box marks the message inserted while any line of it is left", async () => {
  const quote = "In `x.ts` line 2, a check fails:\n```text\nJust post it\n```";
  for (const [typed, inserted] of [[(box: string) => `just post it\n\n${box}`, true], [() => "just post it", false]] as const) {
    const startConversation = vi.fn(async () => ({ threadId: "th-1" }));
    const { inject } = await renderDock({}, { getConversation: unstarted, startConversation });
    await screen.findByText("Ask about this change.");
    inject({ file: "x.ts" }, quote);
    const box = screen.getByRole("textbox", { name: "Ask the agent" }) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe(quote));
    fireEvent.change(box, { target: { value: typed(box.value) } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByTestId("bb-thread-chat");
    expect(startConversation).toHaveBeenCalledWith(expect.objectContaining({ inserted }));
    cleanup();
  }
});

test("the agent's header names its review by its id", async () => {
  await renderDock({ reviewId: "api#4512" }, { getConversation: unstarted });
  await screen.findByText("Ask about this change.");
  expect(within(screen.getByRole("region", { name: "Review agent" })).getByRole("heading", { level: 2 }).textContent).toBe("Review agent·api#4512");
});

test("an ask made before the tab mounts, as the ask that opens BB's panel is, is taken as it opens, once", async () => {
  const asked = { context: { file: "src/a.ts", chapterId: "c1" }, nonce: ++nonce };
  const first = await renderDock({}, { getConversation: unstarted }, {}, asked);
  expect(await screen.findByText("a.ts")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Clear selection context" }));
  first.slot.lifecycle.unmount();
  // BB mounting the tab again doesn't ask again.
  await renderDock({}, { getConversation: unstarted }, {}, asked);
  await screen.findByText("Ask about this change.");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByText("a.ts")).toBeNull();
});

test("a first message being written, and its context, survive the tab mounting again, as BB 0.48 mounts it each time its panel opens", async () => {
  const first = await renderDock({ targetKey: "pr-kept" }, { getConversation: unstarted });
  await screen.findByText("Ask about this change.");
  first.inject({ file: "src/kept.ts" });
  fireEvent.change(screen.getByRole("textbox", { name: "Ask the agent" }), { target: { value: "Half a question" } });
  first.slot.lifecycle.unmount();
  await renderDock({ targetKey: "pr-kept" }, { getConversation: unstarted });
  expect(((await screen.findByRole("textbox", { name: "Ask the agent" })) as HTMLTextAreaElement).value).toBe("Half a question");
  expect(screen.getByText("kept.ts")).toBeTruthy();
});

test("Ask agent with nothing to quote, as with no file in view, focuses bb's composer and notes nothing, with no error", async () => {
  const noteInserted = vi.fn(async () => ({ ok: true }));
  const error = vi.spyOn((await import("sonner")).toast, "error");
  const { slot, inject } = await renderDock({}, { getConversation: () => ({ threadId: "th-1", legacy: [], defaults: null }), noteInserted }, { composer: { scope: { kind: "thread", threadId: "th-1" } } });
  await screen.findByTestId("bb-thread-chat");
  inject({ chapterId: "c1" });
  await waitFor(() => expect(slot.inspection.composer.focusCount).toBe(1));
  expect(noteInserted).not.toHaveBeenCalled();
  expect(slot.inspection.composer.text).toBe("");
  expect(error).not.toHaveBeenCalled();
  error.mockRestore();
});

test("an image in the agent's earlier answers shows as a link to it, and yours as you wrote it", async () => {
  const earlier = { threadId: "th-1", legacy: [{ id: 1, role: "user", text: "See ![mine](https://a.example/mine.png)", context: null, createdAt: 1 }, { id: 2, role: "assistant", text: "Here: ![chart](https://attacker.example/c.png)", context: null, createdAt: 2 }], defaults: null };
  await renderDock({}, { getConversation: async () => earlier });
  const leading = within(await screen.findByTestId("bb-thread-chat-leading-content"));
  expect(leading.getByTestId("bb-markdown").textContent).toBe("Here: [Image: chart](https://attacker.example/c.png)");
  expect(leading.getByText("See ![mine](https://a.example/mine.png)")).toBeTruthy();
});

test("an earlier conversation stays visible, and New conversation starts over after confirming", async () => {
  const earlier = { threadId: "th-1", legacy: [{ id: 1, role: "user", text: "Earlier question", context: null, createdAt: 1 }, { id: 2, role: "assistant", text: "Earlier answer", context: null, createdAt: 2 }], defaults: null };
  const getConversation = vi.fn().mockResolvedValueOnce(earlier).mockResolvedValue(unstarted());
  const newConversation = vi.fn(async () => ({ ok: true }));
  await renderDock({}, { getConversation, newConversation });
  const leading = within(await screen.findByTestId("bb-thread-chat-leading-content"));
  expect(leading.getByText("Earlier question")).toBeTruthy();
  // Named like the agent everywhere else in the review.
  expect(leading.getByText("Earlier answer").closest("div.space-y-1")!.textContent).toMatch(/^Agent/);
  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
  fireEvent.click(within(screen.getByRole("alertdialog", { name: "Start a new conversation" })).getByRole("button", { name: "Cancel" }));
  expect(newConversation).not.toHaveBeenCalled();
  // The confirmation takes the focus, on Cancel; Esc cancels it, and the focus goes back.
  const button = screen.getByRole("button", { name: "New conversation" });
  fireEvent.click(button);
  const confirm = within(screen.getByRole("alertdialog", { name: "Start a new conversation" }));
  expect(document.activeElement).toBe(confirm.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(button));
  expect(newConversation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
  fireEvent.click(screen.getByRole("button", { name: "Start new" }));
  await screen.findByText("Ask about this change.");
  expect(newConversation).toHaveBeenCalledExactlyOnceWith({ targetKey: "pr-1" });
  expect(screen.queryByText("Earlier question")).toBeNull();
});

test("a failed start keeps the question to try again", async () => {
  const startConversation = vi.fn(async () => { throw new Error("Provider \"codex\" is disabled."); });
  await renderDock({}, { getConversation: unstarted, startConversation });
  fireEvent.change(await screen.findByRole("textbox", { name: "Ask the agent" }), { target: { value: "A question" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(startConversation).toHaveBeenCalledOnce());
  await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole("textbox", { name: "Ask the agent" }) as HTMLTextAreaElement).value).toBe("A question");
  expect(screen.queryByTestId("bb-thread-chat")).toBeNull();
});

const onFloMac = (connected = true) => () => ({ threadId: null, legacy: [], defaults: { ...codex, hostId: "host_flomac" }, machine: { name: "FloMac", connected } });

test("a new conversation starts on the assistant's chosen machine, choosing from its models", async () => {
  const startConversation = vi.fn(async () => ({ threadId: "th-1" }));
  await renderDock({}, { getConversation: onFloMac(), startConversation });
  const picker = await findPicker(screen);
  expect(picker.dataset).toMatchObject({ routingKind: "host", routingId: "host_flomac" });
  expect(screen.getByText("on FloMac")).toBeTruthy();
  fireEvent.change(within(picker).getByRole("textbox", { name: "Model" }), { target: { value: "gpt-6" } });
  fireEvent.click(within(picker).getByRole("button", { name: "Apply execution selection" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Ask the agent" }), { target: { value: "Is this safe?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByTestId("bb-thread-chat");
  expect(startConversation).toHaveBeenCalledExactlyOnceWith({ targetKey: "pr-1", text: "Is this safe?", typed: "Is this safe?", inserted: false, agent: { ...codex, model: "gpt-6", hostId: "host_flomac" } });
});

test("an offline machine is named, and a refused first message stays in the composer", async () => {
  const startConversation = vi.fn(async () => { throw new Error("FloMac is offline. Wake it, or choose another machine for the review assistant in Review settings."); });
  await renderDock({}, { getConversation: onFloMac(false), startConversation });
  await screen.findByText("FloMac is offline");
  fireEvent.change(screen.getByRole("textbox", { name: "Ask the agent" }), { target: { value: "Is this safe?" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(startConversation).toHaveBeenCalledOnce());
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Ask the agent" }) as HTMLTextAreaElement).disabled).toBe(false));
  expect((screen.getByRole("textbox", { name: "Ask the agent" }) as HTMLTextAreaElement).value).toBe("Is this safe?");
  expect(screen.queryByTestId("bb-thread-chat")).toBeNull();
});
