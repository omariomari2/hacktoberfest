import { test } from "node:test";
import assert from "node:assert/strict";

import { GEMMA_MODEL, createSseParser, handleGemmaChat } from "../src/gemma.ts";

const JPEG_BASE64 = "/9j/4AAQSkZJRgABAQ==";
const env = { GEMINI_API_KEY: "test-key" };

function streamingChatRequest(): Request {
  return new Request("http://localhost/chat", {
    method: "POST",
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      stream: true,
      system: "You are Clicky.",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG_BASE64 } },
            { type: "text", text: "where is save?" },
          ],
        },
      ],
    }),
  });
}

/** Gemini SSE text for a sequence of response chunks, CRLF-delimited like the real API. */
function geminiSse(chunks: unknown[]): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join("");
}

function textChunk(text: string, thought = false) {
  return { candidates: [{ content: { role: "model", parts: [thought ? { text, thought } : { text }] } }] };
}

/** Upstream body that delivers `bytes` split at the given offsets. */
function fragmentedBody(bytes: Uint8Array, splitAt: number[]): ReadableStream<Uint8Array> {
  const offsets = [0, ...splitAt, bytes.length];
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= offsets.length - 1) return controller.close();
      controller.enqueue(bytes.slice(offsets[index], offsets[index + 1]));
      index += 1;
    },
  });
}

function fakeStreamingGemini(body: () => ReadableStream<Uint8Array>) {
  const calls: { url: string; signal?: AbortSignal | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init?.signal });
    return new Response(body(), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** Mirrors ClaudeAPI.swift: split into lines, keep "data: " lines, accumulate text_delta. */
function swiftParse(sse: string) {
  let text = "";
  const otherEvents: any[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      text += event.delta.text;
    } else {
      otherEvents.push(event);
    }
  }
  return { text, otherEvents };
}

const ANSWER_CHUNKS = [
  textChunk("hidden reasoning", true),
  textChunk("Click the 💾 Save "),
  textChunk("button — top right. "),
  textChunk("[POINT:1180,42:Save:screen1]"),
];
const EXPECTED_TEXT = "Click the 💾 Save button — top right. [POINT:1180,42:Save:screen1]";

test("streams translated deltas with the Swift-compatible shape", async () => {
  const bytes = new TextEncoder().encode(geminiSse(ANSWER_CHUNKS));
  const { calls, fetchImpl } = fakeStreamingGemini(() => fragmentedBody(bytes, []));

  const response = await handleGemmaChat(streamingChatRequest(), env, { fetchImpl });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("x-clicky-model"), GEMMA_MODEL);
  assert.match(calls[0].url, new RegExp(`/models/${GEMMA_MODEL}:streamGenerateContent\\?alt=sse$`));

  const { text, otherEvents } = swiftParse(await response.text());
  assert.equal(text, EXPECTED_TEXT);
  assert.deepEqual(otherEvents, [{ type: "message_stop" }]);
});

test("produces identical text for every single split point, including inside multi-byte characters and CRLF", async () => {
  const bytes = new TextEncoder().encode(geminiSse(ANSWER_CHUNKS));
  for (let split = 1; split < bytes.length; split++) {
    const { fetchImpl } = fakeStreamingGemini(() => fragmentedBody(bytes, [split]));
    const response = await handleGemmaChat(streamingChatRequest(), env, { fetchImpl });
    const { text } = swiftParse(await response.text());
    assert.equal(text, EXPECTED_TEXT, `split at byte ${split}`);
  }
});

test("handles one-byte chunks and several events per chunk", async () => {
  const bytes = new TextEncoder().encode(geminiSse(ANSWER_CHUNKS));
  const everyByte = Array.from({ length: bytes.length - 1 }, (_, i) => i + 1);
  for (const splits of [everyByte, []]) {
    const { fetchImpl } = fakeStreamingGemini(() => fragmentedBody(bytes, splits));
    const { text } = swiftParse(await (await handleGemmaChat(streamingChatRequest(), env, { fetchImpl })).text());
    assert.equal(text, EXPECTED_TEXT);
  }
});

test("delivers each delta before the model has finished", async () => {
  let releaseRest!: () => void;
  const restReleased = new Promise<void>((resolve) => (releaseRest = resolve));
  const encoder = new TextEncoder();

  const { fetchImpl } = fakeStreamingGemini(
    () =>
      new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(geminiSse([textChunk("first ")])));
          await restReleased;
          controller.enqueue(encoder.encode(geminiSse([textChunk("second")])));
          controller.close();
        },
      })
  );

  const response = await handleGemmaChat(streamingChatRequest(), env, { fetchImpl });
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(swiftParse(first).text, "first ", "first delta must arrive while upstream is still open");

  releaseRest();
  let rest = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    rest += new TextDecoder().decode(chunk.value);
  }
  assert.equal(swiftParse(rest).text, "second");
});

test("cancelling the client stream aborts the upstream request", async () => {
  let upstreamCancelled = false;
  const { calls, fetchImpl } = fakeStreamingGemini(
    () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(geminiSse([textChunk("partial")])));
        },
        cancel() {
          upstreamCancelled = true;
        },
      })
  );

  const response = await handleGemmaChat(streamingChatRequest(), env, { fetchImpl });
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();

  assert.equal(calls[0].signal?.aborted, true);
  assert.equal(upstreamCancelled, true);
});

test("client disconnect signal aborts the upstream request", async () => {
  const disconnect = new AbortController();
  const { calls, fetchImpl } = fakeStreamingGemini(() => new ReadableStream({ start() {} }));
  await handleGemmaChat(streamingChatRequest(), env, { fetchImpl, signal: disconnect.signal });
  disconnect.abort();
  assert.equal(calls[0].signal?.aborted, true);
});

test("an upstream error event mid-stream becomes a safe error event", async () => {
  const sse =
    geminiSse([textChunk("partial ")]) +
    geminiSse([{ error: { code: 429, message: "Quota for project AIza-secret exceeded", status: "RESOURCE_EXHAUSTED" } }]) +
    geminiSse([textChunk("must not appear")]);
  const { fetchImpl } = fakeStreamingGemini(() => fragmentedBody(new TextEncoder().encode(sse), []));

  const output = await (await handleGemmaChat(streamingChatRequest(), env, { fetchImpl })).text();
  const { text, otherEvents } = swiftParse(output);

  assert.equal(text, "partial ");
  assert.equal(otherEvents.length, 1);
  assert.equal(otherEvents[0].type, "error");
  assert.equal(otherEvents[0].error.type, "rate_limited");
  assert.ok(!output.includes("AIza"));
});

test("a network failure mid-stream becomes an error event", async () => {
  const { fetchImpl } = fakeStreamingGemini(() => {
    let pulls = 0;
    return new ReadableStream({
      pull(controller) {
        // Erroring in the same pull would discard the queued chunk.
        if (pulls++ === 0) {
          controller.enqueue(new TextEncoder().encode(geminiSse([textChunk("partial")])));
        } else {
          controller.error(new TypeError("socket hang up"));
        }
      },
    });
  });
  const { text, otherEvents } = swiftParse(await (await handleGemmaChat(streamingChatRequest(), env, { fetchImpl })).text());
  assert.equal(text, "partial");
  assert.deepEqual(otherEvents.map((event) => event.error?.type), ["upstream_error"]);
});

test("a stream with only thought parts reports no answer", async () => {
  const sse = geminiSse([textChunk("reasoning only", true)]);
  const { fetchImpl } = fakeStreamingGemini(() => fragmentedBody(new TextEncoder().encode(sse), []));
  const { text, otherEvents } = swiftParse(await (await handleGemmaChat(streamingChatRequest(), env, { fetchImpl })).text());
  assert.equal(text, "");
  assert.equal(otherEvents[0].type, "error");
  assert.ok(!JSON.stringify(otherEvents).includes("reasoning only"));
});

test("an upstream HTTP error before streaming returns a JSON error status", async () => {
  const fetchImpl = (async () => new Response("quota detail", { status: 429 })) as typeof fetch;
  const response = await handleGemmaChat(streamingChatRequest(), env, { fetchImpl });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.type, "rate_limited");
});

test("SSE parser joins multi-line data and ignores comments", () => {
  const events: string[] = [];
  const parser = createSseParser((data) => events.push(data));
  parser.push(new TextEncoder().encode(": keep-alive\n\ndata: a\ndata: b\n\nevent: x\ndata: c"));
  parser.end();
  assert.deepEqual(events, ["a\nb", "c"]);
});
