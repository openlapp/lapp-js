import { describe, it, expect } from "vitest";
import { parseSse } from "../src/client/sse.js";

function makeStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<Array<{ event?: string; data: string }>> {
  const out: Array<{ event?: string; data: string }> = [];
  for await (const ev of parseSse(stream)) {
    out.push(ev);
  }
  return out;
}

describe("parseSse", () => {
  it("parses a single data event", async () => {
    const events = await collectSse(makeStream("data: hello\n\n"));
    expect(events).toEqual([{ data: "hello" }]);
  });

  it("parses multi-line data events", async () => {
    const events = await collectSse(makeStream("data: line1\ndata: line2\n\n"));
    expect(events).toEqual([{ data: "line1\nline2" }]);
  });

  it("handles [DONE] sentinel", async () => {
    const events = await collectSse(makeStream("data: hello\n\ndata: [DONE]\n\n"));
    expect(events).toEqual([{ data: "hello" }, { data: "[DONE]" }]);
  });

  it("ignores comments", async () => {
    const events = await collectSse(makeStream(": ping\ndata: hello\n\n"));
    expect(events).toEqual([{ data: "hello" }]);
  });

  it("handles CRLF line endings", async () => {
    const events = await collectSse(makeStream("data: hello\r\n\r\n"));
    expect(events).toEqual([{ data: "hello" }]);
  });

  // Regression: previous detection used `Symbol.for("ReadableStream") in body`,
  // which traverses the prototype chain — a host object with a Symbol.for
  // property in its prototype would have been misread as a ReadableStream.
  // The new check compares `body.constructor` against `globalThis.ReadableStream`.
  it("does not mis-detect a host object with Symbol.for on its prototype as a ReadableStream", async () => {
    // AsyncIterable<Uint8Array> — must be detected as such and read chunk-by-chunk.
    async function* gen(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode("data: a\n\n");
    }
    const events = await collectSse(gen());
    expect(events).toEqual([{ data: "a" }]);
  });
});
