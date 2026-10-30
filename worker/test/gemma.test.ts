import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_LIMITS,
  GEMMA_MODEL,
  extractVisibleText,
  handleGemmaChat,
  translateChatRequest,
} from "../src/gemma.ts";

// Smallest valid prefixes of each format; the adapter only checks magic bytes.
const JPEG_BASE64 = "/9j/4AAQSkZJRgABAQ==";
const PNG_BASE64 = "iVBORw0KGgo=";

/** Mirrors the body ClaudeAPI.swift builds in analyzeImageStreaming. */
function swiftClientBody(overrides: Record<string, unknown> = {}) {
  return {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    stream: false,
    system: "You are Clicky.",
    messages: [
      { role: "user", content: "what's on screen?" },
      { role: "assistant", content: "a browser [POINT:10,20:tab:screen1]" },
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG_BASE64 } },
          { type: "text", text: "screen1 (primary, 1280x800)" },
          { type: "text", text: "where is the save button?" },
        ],
      },
    ],
    ...overrides,
  };
}

function chatRequest(body: unknown): Request {
  return new Request("http://localhost/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

interface CapturedCall {
  url: string;
  headers: Headers;
  body: any;
}

function fakeGemini(response: Response | (() => Response)) {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return typeof response === "function" ? response() : response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function geminiJson(parts: unknown[]): Response {
  return Response.json({ candidates: [{ content: { role: "model", parts } }] });
}

const env = { GEMINI_API_KEY: "test-key" };

test("translates history, labeled images and prompt into Gemini contents", () => {
  const { geminiRequest, stream, imageCount } = translateChatRequest(swiftClientBody());

  assert.equal(stream, false);
  assert.equal(imageCount, 1);
  assert.deepEqual(geminiRequest.contents, [
    { role: "user", parts: [{ text: "You are Clicky." }, { text: "what's on screen?" }] },
    { role: "model", parts: [{ text: "a browser [POINT:10,20:tab:screen1]" }] },
    {
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: JPEG_BASE64 } },
        { text: "screen1 (primary, 1280x800)" },
        { text: "where is the save button?" },
      ],
    },
  ]);
  assert.equal(geminiRequest.systemInstruction, undefined);
  assert.equal(geminiRequest.generationConfig.maxOutputTokens, 1024);
});

test("instruction mode sends the system prompt as systemInstruction", () => {
  const { geminiRequest } = translateChatRequest(swiftClientBody(), "instruction");
  assert.deepEqual(geminiRequest.systemInstruction, { parts: [{ text: "You are Clicky." }] });
  assert.deepEqual(geminiRequest.contents[0].parts, [{ text: "what's on screen?" }]);
});

test("accepts PNG images and clamps max_tokens", () => {
  const body = swiftClientBody({ max_tokens: 999_999 });
  body.messages[2].content = [
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
    { type: "text", text: "hi" },
  ];
  const { geminiRequest } = translateChatRequest(body);
  assert.equal(geminiRequest.generationConfig.maxOutputTokens, CHAT_LIMITS.maxMaxTokens);
});

test("extractVisibleText drops thought parts and keeps POINT tags", () => {
  const text = extractVisibleText({
    candidates: [
      {
        content: {
          parts: [
            { text: "internal reasoning", thought: true },
            { text: "Click Save. " },
            { text: "[POINT:640,40:Save:screen1]" },
          ],
        },
      },
    ],
  });
  assert.equal(text, "Click Save. [POINT:640,40:Save:screen1]");
});

test("nonstreaming chat pins Gemma and returns the Swift content shape", async () => {
  const { calls, fetchImpl } = fakeGemini(
    geminiJson([{ text: "thinking...", thought: true }, { text: "Click Save. [POINT:640,40:Save:screen1]" }])
  );

  const response = await handleGemmaChat(chatRequest(swiftClientBody()), env, { fetchImpl });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-clicky-model"), GEMMA_MODEL);
  assert.deepEqual(await response.json(), {
    model: GEMMA_MODEL,
    content: [{ type: "text", text: "Click Save. [POINT:640,40:Save:screen1]" }],
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, new RegExp(`/models/${GEMMA_MODEL}:generateContent$`));
  assert.equal(calls[0].headers.get("x-goog-api-key"), "test-key");
  assert.ok(!calls[0].url.includes("test-key"), "key must not be in the URL");
  assert.ok(!JSON.stringify(calls[0].body).includes("claude"), "client model name must not reach Gemini");
});

async function expectError(response: Response, status: number, type: string) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.type, type);
  assert.equal(typeof body.error.message, "string");
  return body.error.message as string;
}

test("rejects bad input before calling the model", async (t) => {
  const { calls, fetchImpl } = fakeGemini(geminiJson([{ text: "unused" }]));
  const imageBlock = (media_type: string, data: string) => ({
    type: "image",
    source: { type: "base64", media_type, data },
  });
  const withContent = (content: unknown[]) =>
    swiftClientBody({ messages: [{ role: "user", content }] });

  const cases: [string, unknown, number, string][] = [
    ["invalid JSON", "{not json", 400, "invalid_request"],
    ["missing messages", { system: "x" }, 400, "invalid_request"],
    ["unknown role", { messages: [{ role: "system", content: "x" }] }, 400, "invalid_request"],
    ["unknown block type", withContent([{ type: "document" }]), 400, "invalid_request"],
    ["gif image", withContent([imageBlock("image/gif", JPEG_BASE64)]), 415, "unsupported_media_type"],
    ["PNG bytes labeled JPEG", withContent([imageBlock("image/jpeg", PNG_BASE64)]), 415, "unsupported_media_type"],
    ["non-base64 data", withContent([imageBlock("image/jpeg", "not base64!")]), 400, "invalid_request"],
    [
      "too many images",
      withContent(Array.from({ length: CHAT_LIMITS.maxImages + 1 }, () => imageBlock("image/jpeg", JPEG_BASE64))),
      400,
      "invalid_request",
    ],
    [
      "oversized image",
      withContent([imageBlock("image/jpeg", "/9j/" + "A".repeat(4 * Math.ceil(CHAT_LIMITS.maxImageBytes / 3)))]),
      413,
      "payload_too_large",
    ],
    [
      "oversized body",
      swiftClientBody({ system: "x".repeat(CHAT_LIMITS.maxBodyBytes) }),
      413,
      "payload_too_large",
    ],
  ];

  for (const [name, body, status, type] of cases) {
    await t.test(name, async () => {
      await expectError(await handleGemmaChat(chatRequest(body), env, { fetchImpl }), status, type);
    });
  }
  assert.equal(calls.length, 0);
});

test("reports a missing API key as not_configured", async () => {
  const { calls, fetchImpl } = fakeGemini(geminiJson([{ text: "unused" }]));
  await expectError(await handleGemmaChat(chatRequest(swiftClientBody()), {}, { fetchImpl }), 503, "not_configured");
  assert.equal(calls.length, 0);
});

test("maps upstream errors without forwarding the upstream body", async (t) => {
  const secretish = "API key AIza-leaked-detail quota project 12345";
  const cases: [number, number, string][] = [
    [429, 429, "rate_limited"],
    [400, 502, "upstream_error"],
    [403, 502, "upstream_error"],
    [500, 502, "upstream_error"],
  ];
  for (const [upstreamStatus, status, type] of cases) {
    await t.test(`upstream ${upstreamStatus}`, async () => {
      const { fetchImpl } = fakeGemini(() => new Response(secretish, { status: upstreamStatus }));
      const message = await expectError(
        await handleGemmaChat(chatRequest(swiftClientBody()), env, { fetchImpl }),
        status,
        type
      );
      assert.ok(!message.includes("AIza"));
    });
  }
});

test("an empty answer is an upstream error", async () => {
  const { fetchImpl } = fakeGemini(geminiJson([{ text: "only thoughts", thought: true }]));
  await expectError(await handleGemmaChat(chatRequest(swiftClientBody()), env, { fetchImpl }), 502, "upstream_error");
});

test("a slow model times out with 504", async () => {
  const fetchImpl = ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
  await expectError(
    await handleGemmaChat(chatRequest(swiftClientBody()), env, { fetchImpl, timeoutMs: 20 }),
    504,
    "upstream_timeout"
  );
});

test("fills logging metadata without payload contents", async () => {
  const { fetchImpl } = fakeGemini(geminiJson([{ text: "ok" }]));
  const meta: Record<string, unknown> = {};
  await handleGemmaChat(chatRequest(swiftClientBody()), env, { fetchImpl, meta });
  assert.deepEqual(meta, { imageCount: 1, imageBytes: 13, stream: false });
});


test("short companion replies explicitly minimize thinking", () => {
  const translated = translateChatRequest(swiftClientBody());
  assert.deepEqual(translated.geminiRequest.generationConfig.thinkingConfig, { thinkingLevel: "minimal" });
});
