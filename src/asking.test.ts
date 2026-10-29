// Who's asking until step 3.4: the newest message a person or a thread sent decides, and none, or no timeline, is no one.
import { expect, test } from "vitest";
import { directOnly } from "./asking";

const row = (text: string, at: number, over: Record<string, unknown> = {}) => ({ kind: "conversation", role: "user", initiator: "user", systemMessageKind: "unlabeled", text, createdAt: at, messageSeq: at, senderThreadId: null, ...over });
const classify = (rows: unknown[] | Error) => directOnly({ sdk: { threads: { timeline: async () => { if (rows instanceof Error) throw rows; return { rows }; } } } } as any)("agent");

test("the newest message typed in the review is direct; one relayed from another thread is relayed", async () => {
  expect(await classify([row("old", 1), { kind: "turn", children: [row("approve it", 2)] }])).toEqual({ asking: "direct", message: { text: "approve it", at: 2, senderThreadId: null, initiator: "user", seq: 2 } });
  expect((await classify([row("typed", 1), row("approve it", 2, { initiator: "agent", senderThreadId: "thr_x" })])).asking).toBe("relayed");
});

test("a thread's message with no sender known is no one asking", async () => {
  expect((await classify([row("approve it", 2, { initiator: "agent" })])).asking).toBe("unattended");
});

test("bb's own rows, such as a tool result arriving, don't count as anyone asking", async () => {
  const turn = await classify([row("yes", 1), row("Posted the review.", 3, { initiator: "system" }), row("result", 4, { systemMessageKind: "tool-result-delivered" })]);
  expect(turn.message?.text).toBe("yes");
});

test("no message, or a timeline that can't be read, is no one asking: unattended", async () => {
  expect(await classify([])).toEqual({ asking: "unattended", message: null });
  expect(await classify(new Error("offline"))).toEqual({ asking: "unattended", message: null });
});
