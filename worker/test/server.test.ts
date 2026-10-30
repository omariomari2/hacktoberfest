import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { CHAT_LIMITS, GEMMA_MODEL } from "../src/gemma.ts";
import { createClickyServer, type ServerEnv } from "../src/server.ts";

const APP_TOKEN = "demo-token-for-tests";
const JPEG_BASE64 = "/9j/4AAQSkZJRgABAQ==";
const PROMPT_MARKER = "PRIVATE-PROMPT-MARKER";

const env: ServerEnv = { GEMINI_API_KEY: "test-key", CLICKY_APP_TOKEN: APP_TOKEN };

/** Fake upstream: each Gemini call waits until released, then streams one answer. */
const upstream = {
  calls: 0,
  signals: [] as AbortSignal[],
  gate: Promise.resolve(),
  hold() {
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => (release = resolve));
    return release;
  },
};

const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
  upstream.calls += 1;
  if (init?.signal) upstream.signals.push(init.signal);
  await upstream.gate;
  const event = { candidates: [{ content: { parts: [{ text: "Click Save [POINT:1,2:Save:screen1]" }] } }] };
  return new Response(`data: ${JSON.stringify(event)}\r\n\r\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}) as typeof fetch;

// Number of upstream calls made before the current test, for waiting on new ones.
let countEarlierSignals = 0;
test.beforeEach(() => {
  countEarlierSignals = upstream.signals.length;
});

const logLines: string[] = [];
let server: Server;
let baseURL: string;

before(async () => {
  server = createClickyServer(env, { fetchImpl, maxConcurrentChats: 2, log: (line) => logLines.push(line) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

function chatBody(stream = true) {
  return JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    stream,
    system: "You are Clicky.",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG_BASE64 } },
          { type: "text", text: PROMPT_MARKER },
        ],
      },
    ],
  });
}

function postChat(token: string | null = APP_TOKEN, body = chatBody(), signal?: AbortSignal) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return fetch(`${baseURL}/chat`, { method: "POST", headers, body, signal });
}

async function errorType(response: Response) {
  return (await response.json()).error.type;
}

test("refuses to start without an app token", () => {
  assert.throws(() => createClickyServer({ GEMINI_API_KEY: "k" }), /CLICKY_APP_TOKEN/);
});

test("health and TLS warm-up need no token and expose no secrets", async () => {
  const health = await fetch(`${baseURL}/health`);
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.deepEqual(body, { status: "ok", model: GEMMA_MODEL });

  const warmup = await fetch(`${baseURL}/`, { method: "HEAD" });
  assert.equal(warmup.status, 200);
  assert.ok(warmup.headers.get("x-request-id"));
});

test("rejects missing and wrong tokens before calling the model", async () => {
  const callsBefore = upstream.calls;
  for (const token of [null, "wrong", `${APP_TOKEN}x`, ""]) {
    const response = await postChat(token);
    assert.equal(response.status, 401, `token ${JSON.stringify(token)}`);
    assert.equal(await errorType(response), "unauthorized");
  }
  for (const route of ["/tts", "/transcribe-token"]) {
    const response = await fetch(`${baseURL}${route}`, { method: "POST", body: "{}" });
    assert.equal(response.status, 401);
  }
  assert.equal(upstream.calls, callsBefore);
});

test("authenticated chat streams the Gemma answer", async () => {
  const response = await postChat();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("x-clicky-model"), GEMMA_MODEL);
  const text = await response.text();
  assert.match(text, /"text_delta","text":"Click Save \[POINT:1,2:Save:screen1\]"/);
  assert.match(text, /"type":"message_stop"/);
});

test("authenticated nonstreaming chat is rejected as invalid only by content, not auth", async () => {
  const response = await postChat(APP_TOKEN, "{not json");
  assert.equal(response.status, 400);
  assert.equal(await errorType(response), "invalid_request");
});

test("oversized bodies fail with 413 before the model is called", async () => {
  const callsBefore = upstream.calls;
  const response = await postChat(APP_TOKEN, "x".repeat(CHAT_LIMITS.maxBodyBytes + 1));
  assert.equal(response.status, 413);
  assert.equal(await errorType(response), "payload_too_large");
  assert.equal(upstream.calls, callsBefore);
});

test("bounds concurrent chats and frees slots when streams finish", async () => {
  const release = upstream.hold();
  const inFlight = [postChat(), postChat()];
  // Wait until both requests have reached the upstream call.
  while (upstream.signals.length < countEarlierSignals + 2) await new Promise((r) => setTimeout(r, 5));

  const rejected = await postChat();
  assert.equal(rejected.status, 503);
  assert.equal(await errorType(rejected), "busy");

  release();
  for (const response of await Promise.all(inFlight)) {
    assert.equal(response.status, 200);
    await response.text();
  }

  const afterwards = await postChat();
  assert.equal(afterwards.status, 200);
  await afterwards.text();
});
test("client disconnect aborts the upstream request and frees the slot", async () => {
  const release = upstream.hold();
  const client = new AbortController();
  const pending = postChat(APP_TOKEN, chatBody(), client.signal).catch(() => "aborted");
  while (upstream.signals.length < countEarlierSignals + 1) await new Promise((r) => setTimeout(r, 5));

  client.abort();
  assert.equal(await pending, "aborted");
  const signal = upstream.signals.at(-1)!;
  for (let i = 0; i < 100 && !signal.aborted; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(signal.aborted, true);
  release();

  // Both slots must be available again.
  const responses = await Promise.all([postChat(), postChat()]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    await response.text();
  }
});

test("speech routes report not_configured when keys are missing", async () => {
  for (const route of ["/tts", "/transcribe-token"]) {
    const response = await fetch(`${baseURL}${route}`, {
      method: "POST",
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(response.status, 503);
    assert.equal(await errorType(response), "not_configured");
  }
});

test("unknown routes and methods get JSON errors", async () => {
  assert.equal((await fetch(`${baseURL}/nope`)).status, 404);
  const wrongMethod = await fetch(`${baseURL}/chat`, { headers: { authorization: `Bearer ${APP_TOKEN}` } });
  assert.equal(wrongMethod.status, 405);
  assert.equal(await errorType(wrongMethod), "method_not_allowed");
});

test("logs contain request facts but no payloads, tokens or keys", async () => {
  const response = await postChat();
  await response.text();
  await new Promise((r) => setTimeout(r, 20));

  const allLogs = logLines.join("\n");
  assert.ok(logLines.length > 0);
  for (const secret of [PROMPT_MARKER, APP_TOKEN, "test-key", JPEG_BASE64, "Click Save"]) {
    assert.ok(!allLogs.includes(secret), `logs must not contain ${secret}`);
  }
  const chatLog = logLines.map((line) => JSON.parse(line)).find((entry) => entry.route === "/chat" && entry.status === 200);
  assert.ok(chatLog);
  assert.equal(chatLog.imageCount, 1);
  assert.equal(chatLog.stream, true);
  assert.equal(typeof chatLog.ms, "number");
  assert.ok(chatLog.requestId);
});
