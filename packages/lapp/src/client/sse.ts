/**
 * Server-Sent Events parser.
 *
 * Tolerant of LF-only, CRLF, comments, multi-line data fields, and the
 * `data: [DONE]` sentinel.
 */

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* parseSse(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterable<SseEvent> {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";

  // Buffer partial events that span multiple chunks. We emit only complete
  // events (separated by a blank line), but we also need to accumulate
  // consecutive `data:` lines within a single event. Declared at the top of
  // the function so the inner `processBuffer` generator can see them — TDZ
  // errors here would otherwise crash on the very first event.
  const pendingData: string[] = [];
  let pendingEvent: string | undefined;

  const append = (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
  };

  const flushBuffer = () => {
    buffer += decoder.decode(undefined, { stream: false });
  };

  // Detect a Web `ReadableStream` so we can read it via the `getReader()`
  // path. The standard check is `body instanceof ReadableStream`, but a
  // // @ts-expect-error — the global type may not be present in the
  // // current lib config (e.g. when this file is consumed by older
  // // toolchains that target ES2022 only). The `Symbol.for` check is a
  // // runtime tag every Web ReadableStream carries; `globalThis.ReadableStream`
  // // is the constructor to compare against, avoiding prototype-chain
  // // traversal.
  const WebStream = (globalThis as { ReadableStream?: unknown }).ReadableStream;
  const isReadableStream =
    typeof WebStream === "function" && (body as { constructor?: unknown })?.constructor === WebStream;
  const reader = isReadableStream
    ? (body as ReadableStream<Uint8Array>).getReader()
    : undefined;

  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) append(value);
      yield* processBuffer();
    }

    if (!reader) {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        append(chunk);
        yield* processBuffer();
      }
    }
  } finally {
    if (reader) {
      try { await reader.cancel(); } catch { /* ignore */ }
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  flushBuffer();
  yield* processBuffer(true);
  yield* flushPending();

  function* processBuffer(final = false): Generator<SseEvent> {
    while (true) {
      const crlf = buffer.indexOf("\r\n");
      const lf = buffer.indexOf("\n");
      let eol = -1;
      let sepLen = 1;
      if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
        eol = crlf;
        sepLen = 2;
      } else if (lf !== -1) {
        eol = lf;
        sepLen = 1;
      } else if (final) {
        // No trailing newline but we are done; process remaining as a line.
        if (buffer.length > 0) {
          const line = buffer;
          buffer = "";
          const ev = parseLine(line);
          if (ev) yield ev;
        }
        break;
      } else {
        break;
      }

      const line = buffer.slice(0, eol);
      buffer = buffer.slice(eol + sepLen);
      // A blank line terminates the event — flush any accumulated data
      // immediately, before any further parsing. parseLine("") returns null
      // and skipping the rest of the loop would lose the terminator.
      if (line === "") {
        yield* flushPending();
        continue;
      }
      const ev = parseLine(line);
      if (ev === null) continue;
      if (ev.event !== undefined) {
        pendingEvent = ev.event;
      } else if (ev.data !== undefined) {
        pendingData.push(ev.data);
      }
    }
  }

  function parseLine(line: string): SseEvent | null {
    if (line.startsWith(":")) return null; // comment / heartbeat
    if (line === "") return null;
    const colon = line.indexOf(":");
    if (colon === -1) return null;
    const field = line.slice(0, colon);
    // Optional leading space after colon.
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") return { data: value };
    if (field === "event") return { event: value, data: "" };
    // Unknown fields ignored.
    return null;
  }

  function* flushPending(): Generator<SseEvent> {
    if (pendingData.length > 0) {
      yield { event: pendingEvent, data: pendingData.join("\n") };
      pendingData.length = 0;
      pendingEvent = undefined;
    }
  }
}
