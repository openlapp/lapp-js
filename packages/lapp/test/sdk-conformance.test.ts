import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createLappClient,
  type ChatInput,
  type LappProfile,
  type LappResponse,
  type LappStreamEventUnion,
} from "../src/index.js";

interface ProtocolFixture {
  fixtureVersion: "1.0";
  protocol: string;
  context: {
    providerId: string;
    baseUrl: string;
    model: string;
    auth: { type: "none" };
    requestHeaders: Record<string, string>;
  };
  request: {
    input: ChatInput;
    expected: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body: unknown;
      stream: boolean;
    };
  };
  nonStream: { upstream: unknown; expected: LappResponse };
  sse: { wire: string; expectedEvents: LappStreamEventUnion[] };
  tools: {
    input: ChatInput;
    expectedBody: unknown;
    upstream: unknown;
    expected: LappResponse;
  };
}

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

const fixtureDirectory = fileURLToPath(new URL("../conformance/sdk-v1/", import.meta.url));
const fixtures = fs.readdirSync(fixtureDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => JSON.parse(
    fs.readFileSync(path.join(fixtureDirectory, name), "utf8"),
  ) as ProtocolFixture)
  .filter((fixture) => [
    "openai-chat-completions",
    "openai-responses",
    "anthropic-messages",
  ].includes(fixture.protocol));

function profile(fixture: ProtocolFixture): LappProfile {
  return {
    global: {
      schemaVersion: "1.0",
      defaults: {
        chat: {
          providerId: fixture.context.providerId,
          modelId: fixture.context.model,
        },
      },
    },
    providers: [{
      config: {
        schemaVersion: "1.0",
        id: fixture.context.providerId,
        baseUrl: fixture.context.baseUrl,
        protocols: [fixture.protocol],
        auth: fixture.context.auth,
        requestHeaders: fixture.context.requestHeaders,
      },
      models: {
        schemaVersion: "1.0",
        models: [{ id: fixture.context.model, protocols: [fixture.protocol] }],
      },
    }],
  };
}

function normalizedHeaders(value: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(
    [...new Headers(value).entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function expectRequest(captured: CapturedRequest, fixture: ProtocolFixture): void {
  const expected = fixture.request.expected;
  expect(captured.url).toBe(expected.url);
  expect(captured.init.method).toBe(expected.method);
  expect(normalizedHeaders(captured.init.headers)).toEqual(normalizedHeaders(expected.headers));
  expect(JSON.parse(String(captured.init.body))).toEqual(expected.body);
}

function normalizedResponse(response: LappResponse): Omit<LappResponse, "raw"> {
  const { raw, ...normalized } = response;
  void raw;
  return normalized;
}

describe.each(fixtures)("canonical SDK conformance: $protocol", (fixture) => {
  it("matches the streaming request and SSE event sequence", async () => {
    let captured: CapturedRequest | undefined;
    const client = createLappClient({
      profile: profile(fixture),
      fetchImpl: async (input, init = {}) => {
        captured = { url: String(input), init };
        return new Response(fixture.sse.wire, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const events: LappStreamEventUnion[] = [];
    for await (const event of client.stream(fixture.request.input)) events.push(event);

    expect(captured).toBeDefined();
    expectRequest(captured!, fixture);
    expect(events).toEqual(fixture.sse.expectedEvents);
  });

  it("matches the normalized non-stream response", async () => {
    const client = createLappClient({
      profile: profile(fixture),
      fetchImpl: async () => new Response(JSON.stringify(fixture.nonStream.upstream), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    const response = await client.chat({ ...fixture.request.input, stream: false });
    expect(normalizedResponse(response)).toEqual(fixture.nonStream.expected);
  });

  it("matches tool request encoding and parsed tool calls", async () => {
    let body: unknown;
    const client = createLappClient({
      profile: profile(fixture),
      fetchImpl: async (_input, init = {}) => {
        body = JSON.parse(String(init.body));
        return new Response(JSON.stringify(fixture.tools.upstream), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const response = await client.chat(fixture.tools.input);
    expect(body).toEqual(fixture.tools.expectedBody);
    expect(normalizedResponse(response)).toEqual(fixture.tools.expected);
  });
});
