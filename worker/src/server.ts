/**
 * Node HTTP service for DigitalOcean (see tasks/contract.md).
 *
 *   GET  /health            unauthenticated status
 *   HEAD /                  unauthenticated TLS warm-up for ClaudeAPI.swift
 *   POST /chat              Gemma (src/gemma.ts), app token required
 *   POST /tts               ElevenLabs, app token required
 *   POST /transcribe-token  AssemblyAI, app token required
 *
 * Logs one line per request with ID, route, status, timing and image
 * sizes only — never bodies, prompts, model output, tokens or keys.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { CHAT_LIMITS, GEMMA_MODEL, errorResponse, handleGemmaChat, type GemmaEnv } from "./gemma.ts";
import { handleTTS, handleTranscribeToken, type SpeechEnv } from "./speech.ts";

export interface ServerEnv extends GemmaEnv, SpeechEnv {
  CLICKY_APP_TOKEN?: string;
}

export interface ServerOptions {
  fetchImpl?: typeof fetch;
  maxConcurrentChats?: number;
  upstreamTimeoutMs?: number;
  log?: (line: string) => void;
}

type ChatMeta = { imageCount?: number; imageBytes?: number; stream?: boolean };

const MAX_SPEECH_BODY_BYTES = 64 * 1024;

export function createClickyServer(env: ServerEnv, options: ServerOptions = {}): Server {
  if (!env.CLICKY_APP_TOKEN) {
    throw new Error("CLICKY_APP_TOKEN must be set; refusing to start an unauthenticated backend");
  }
  const expectedTokenDigest = sha256(env.CLICKY_APP_TOKEN);
  const maxConcurrentChats = options.maxConcurrentChats ?? 4;
  const log = options.log ?? ((line: string) => console.log(line));
  let activeChats = 0;

  const isAuthorized = (request: IncomingMessage): boolean => {
    const header = request.headers.authorization ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return false;
    // Comparing fixed-length digests keeps the comparison constant-time regardless of token length.
    return timingSafeEqual(sha256(match[1]), expectedTokenDigest);
  };

  return createServer(async (request, response) => {
    const requestId = randomUUID();
    const started = performance.now();
    const route = (request.url ?? "/").split("?")[0];
    const meta: ChatMeta = {};
    response.setHeader("x-request-id", requestId);

    // Aborts upstream work when the client goes away before we finish.
    const clientGone = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) clientGone.abort();
    });
    response.on("close", () => {
      log(
        JSON.stringify({
          requestId,
          method: request.method,
          route,
          status: response.statusCode,
          ms: Math.round(performance.now() - started),
          completed: response.writableFinished,
          ...meta,
        })
      );
    });

    try {
      const webResponse = await routeRequest(request, route, meta, clientGone.signal);
      await sendWebResponse(webResponse, response);
    } catch (error) {
      log(JSON.stringify({ requestId, route, unhandledError: error instanceof Error ? error.name : "unknown" }));
      if (!response.headersSent) {
        await sendWebResponse(errorResponse(500, "internal_error", "Internal server error"), response);
      } else {
        response.destroy();
      }
    }
  });

  async function routeRequest(
    request: IncomingMessage,
    route: string,
    meta: ChatMeta,
    signal: AbortSignal
  ): Promise<Response> {
    if (route === "/health" && (request.method === "GET" || request.method === "HEAD")) {
      return Response.json({ status: "ok", model: GEMMA_MODEL });
    }
    if (route === "/" && request.method === "HEAD") {
      return new Response(null, { status: 200 });
    }

    const isProtectedRoute = route === "/chat" || route === "/tts" || route === "/transcribe-token";
    if (!isProtectedRoute) {
      return errorResponse(404, "not_found", "Not found");
    }
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "Use POST");
    }
    if (!isAuthorized(request)) {
      request.resume();
      return errorResponse(401, "unauthorized", "Missing or invalid app token");
    }

    if (route === "/transcribe-token") {
      request.resume();
      return handleTranscribeToken(env, { fetchImpl: options.fetchImpl, signal });
    }

    if (route === "/tts") {
      const body = await readBodyWithLimit(request, MAX_SPEECH_BODY_BYTES);
      if (body === null) return errorResponse(413, "payload_too_large", "Request body is too large");
      return handleTTS(toWebRequest(request, body), env, { fetchImpl: options.fetchImpl, signal });
    }

    // /chat
    if (activeChats >= maxConcurrentChats) {
      request.resume();
      return errorResponse(503, "busy", "The backend is busy; try again in a moment");
    }
    activeChats += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        activeChats -= 1;
      }
    };
    try {
      const body = await readBodyWithLimit(request, CHAT_LIMITS.maxBodyBytes);
      if (body === null) {
        release();
        return errorResponse(
          413,
          "payload_too_large",
          `Request body must be at most ${CHAT_LIMITS.maxBodyBytes / (1024 * 1024)} MB`
        );
      }
      const chatResponse = await handleGemmaChat(toWebRequest(request, body), env, {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.upstreamTimeoutMs,
        signal,
        meta,
      });
      // A streamed answer keeps its slot until the body is fully sent or cancelled.
      return chatResponse.body ? withRelease(chatResponse, release) : (release(), chatResponse);
    } catch (error) {
      release();
      throw error;
    }
  }
}

/** Reads the request body, returning null (and draining the rest) once it exceeds `maxBytes`. */
async function readBodyWithLimit(request: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  if (Number(request.headers["content-length"] ?? 0) > maxBytes) {
    request.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      request.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function toWebRequest(request: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  return new Request(`http://internal${request.url ?? "/"}`, {
    method: request.method,
    headers,
    body: new Uint8Array(body),
  });
}

/** Wraps a response body so `release` runs once it finishes, fails or is cancelled. */
function withRelease(response: Response, release: () => void): Response {
  const reader = response.body!.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

async function sendWebResponse(webResponse: Response, response: ServerResponse): Promise<void> {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));

  if (!webResponse.body) {
    response.end();
    return;
  }

  const reader = webResponse.body.getReader();
  const onClose = () => reader.cancel().catch(() => {});
  response.once("close", onClose);
  try {
    response.flushHeaders();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      if (response.destroyed) break;
      if (!response.write(chunk.value)) {
        await Promise.race([once(response, "drain"), once(response, "close")]);
      }
    }
  } finally {
    response.off("close", onClose);
    if (response.destroyed) {
      await reader.cancel().catch(() => {});
    } else {
      response.end();
    }
  }
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
