import { describe, it, expect } from "vitest";
import { computeThreadMessageFingerprint } from "./threadFingerprint";
import type { DbMessage } from "@/services/db/messages";

function msg(id: string): DbMessage {
  return {
    id,
    account_id: "acc1",
    thread_id: "t1",
    date: 1,
  } as DbMessage;
}

describe("computeThreadMessageFingerprint", () => {
  it("returns empty string for no messages", () => {
    expect(computeThreadMessageFingerprint([])).toBe("");
  });

  it("changes when message count changes", () => {
    const one = computeThreadMessageFingerprint([msg("a")]);
    const two = computeThreadMessageFingerprint([msg("a"), msg("b")]);
    expect(one).not.toBe(two);
  });

  it("changes when message ids change", () => {
    const a = computeThreadMessageFingerprint([msg("a"), msg("b")]);
    const b = computeThreadMessageFingerprint([msg("a"), msg("c")]);
    expect(a).not.toBe(b);
  });

  it("is stable for the same messages", () => {
    const messages = [msg("a"), msg("b")];
    expect(computeThreadMessageFingerprint(messages)).toBe(
      computeThreadMessageFingerprint([...messages]),
    );
  });
});
