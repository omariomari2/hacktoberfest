/**
 * Gemma adapter for POST /chat.
 *
 * Accepts the Anthropic-shaped body that ClaudeAPI.swift already sends,
 * translates it to a Gemini API request pinned to Gemma, and translates
 * the answer back into the shapes the Swift client parses. See
 * tasks/contract.md for the frozen contract.
 *
 * Uses only Web-standard APIs (fetch, Request, Response) so it runs on
 * Node and on Cloudflare Workers.
 */

export const GEMMA_MODEL = "gemma-4-26b-a4b-it";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export const CHAT_LIMITS = {
  maxBodyBytes: 10 * 1024 * 1024,
  maxImages: 4,
  maxImageBytes: 4 * 1024 * 1024,
  maxMessages: 40,
  defaultMaxTokens: 1024,
  maxMaxTokens: 2048,
  upstreamTimeoutMs: 90_000,
};

export type ChatErrorType =
  | "invalid_request"
  | "payload_too_large"
  | "unsupported_media_type"
  | "rate_limited"
  | "upstream_error"
  | "upstream_timeout"
  | "not_configured";

/** An error whose message is safe to show to the user. */
export class ChatError extends Error {
  readonly status: number;
  readonly type: ChatErrorType;

  constructor(status: number, type: ChatErrorType, message: string) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

export function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- Gemini request shapes -------------------------------------------------

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiRequest {
  systemInstruction?: { parts: { text: string }[] };
  contents: GeminiContent[];
  generationConfig: { maxOutputTokens: number; thinkingConfig: { thinkingLevel: "minimal" } };
}

/**
 * "prepend" puts the system prompt in front of the first user turn, which
 * works for every Gemma model. "instruction" uses Gemini's systemInstruction
 * field, which some Gemma models reject.
 */
export type SystemPromptMode = "prepend" | "instruction";

export interface TranslatedChat {
  geminiRequest: GeminiRequest;
  stream: boolean;
  imageCount: number;
  imageBytes: number;
}

// --- Request translation ---------------------------------------------------

export function translateChatRequest(
  body: unknown,
  systemPromptMode: SystemPromptMode = "prepend"
): TranslatedChat {
  if (!isRecord(body)) {
    throw invalid("Request body must be a JSON object");
  }

  const { messages, system, stream, max_tokens: maxTokens } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw invalid("messages must be a non-empty array");
  }
  if (messages.length > CHAT_LIMITS.maxMessages) {
    throw invalid(`At most ${CHAT_LIMITS.maxMessages} messages are allowed`);
  }
  if (system !== undefined && typeof system !== "string") {
    throw invalid("system must be a string");
  }
  if (stream !== undefined && typeof stream !== "boolean") {
    throw invalid("stream must be a boolean");
  }

  let imageCount = 0;
  let imageBytes = 0;

  const contents: GeminiContent[] = messages.map((message, messageIndex) => {
    if (!isRecord(message)) {
      throw invalid(`messages[${messageIndex}] must be an object`);
    }
    const role = message.role === "user" ? "user" : message.role === "assistant" ? "model" : null;
    if (role === null) {
      throw invalid(`messages[${messageIndex}].role must be "user" or "assistant"`);
    }

    const parts: GeminiPart[] = [];
    const content = message.content;

    if (typeof content === "string") {
      if (content.length > 0) parts.push({ text: content });
    } else if (Array.isArray(content)) {
      content.forEach((block, blockIndex) => {
        const where = `messages[${messageIndex}].content[${blockIndex}]`;
        if (!isRecord(block)) throw invalid(`${where} must be an object`);

        if (block.type === "text") {
          if (typeof block.text !== "string") throw invalid(`${where}.text must be a string`);
          if (block.text.length > 0) parts.push({ text: block.text });
        } else if (block.type === "image") {
          if (role !== "user") throw invalid(`${where}: images are only allowed in user messages`);
          imageCount += 1;
          if (imageCount > CHAT_LIMITS.maxImages) {
            throw invalid(`At most ${CHAT_LIMITS.maxImages} images are allowed`);
          }
          const image = validateImageBlock(block, where);
          imageBytes += image.decodedBytes;
          parts.push({ inlineData: { mimeType: image.mediaType, data: image.data } });
        } else {
          throw invalid(`${where}.type must be "text" or "image"`);
        }
      });
    } else {
      throw invalid(`messages[${messageIndex}].content must be a string or an array`);
    }

    if (parts.length === 0) {
      throw invalid(`messages[${messageIndex}] has no content`);
    }
    return { role, parts };
  });

  if (contents[0].role !== "user") {
    throw invalid("The first message must come from the user");
  }
  if (contents[contents.length - 1].role !== "user") {
    throw invalid("The last message must come from the user");
  }

  const geminiRequest: GeminiRequest = {
    contents,
    generationConfig: {
      maxOutputTokens: clampMaxTokens(maxTokens),
      thinkingConfig: { thinkingLevel: "minimal" },
    },
  };

  if (typeof system === "string" && system.length > 0) {
    if (systemPromptMode === "instruction") {
      geminiRequest.systemInstruction = { parts: [{ text: system }] };
    } else {
      contents[0].parts.unshift({ text: system });
    }
  }

  return { geminiRequest, stream: stream === true, imageCount, imageBytes };
}

function validateImageBlock(
  block: Record<string, unknown>,
  where: string
): { mediaType: string; data: string; decodedBytes: number } {
  const source = block.source;
  if (!isRecord(source) || source.type !== "base64") {
    throw invalid(`${where}.source must be a base64 image source`);
  }
  const mediaType = source.media_type;
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") {
    throw new ChatError(415, "unsupported_media_type", "Only JPEG and PNG images are supported");
  }
  const data = source.data;
  if (typeof data !== "string" || data.length === 0 || !isBase64(data)) {
    throw invalid(`${where}.source.data must be base64`);
  }

  const decodedBytes = base64DecodedLength(data);
  if (decodedBytes > CHAT_LIMITS.maxImageBytes) {
    throw new ChatError(
      413,
      "payload_too_large",
      `Each image must be at most ${CHAT_LIMITS.maxImageBytes / (1024 * 1024)} MB`
    );
  }

  const header = decodeBase64Prefix(data, 4);
  const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47;
  if ((mediaType === "image/jpeg" && !isJpeg) || (mediaType === "image/png" && !isPng)) {
    throw new ChatError(415, "unsupported_media_type", "Image bytes do not match the declared media type");
  }

  return { mediaType, data, decodedBytes };
}

function clampMaxTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return CHAT_LIMITS.defaultMaxTokens;
  return Math.min(CHAT_LIMITS.maxMaxTokens, Math.max(1, Math.floor(value)));
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

function base64DecodedLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function decodeBase64Prefix(value: string, byteCount: number): number[] {
  const chunk = value.slice(0, Math.ceil(byteCount / 3) * 4);
  return Array.from(atob(chunk), (char) => char.charCodeAt(0)).slice(0, byteCount);
}

// --- Response translation --------------------------------------------------

/** Joins the visible text parts of a Gemini response, dropping thought parts. */
export function extractVisibleText(geminiResponse: unknown): string {
  const parts = firstCandidateParts(geminiResponse);
  return parts
    .filter((part) => part.thought !== true && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

function firstCandidateParts(geminiResponse: unknown): Record<string, unknown>[] {
  if (!isRecord(geminiResponse) || !Array.isArray(geminiResponse.candidates)) return [];
  const candidate = geminiResponse.candidates[0];
  if (!isRecord(candidate) || !isRecord(candidate.content)) return [];
  const parts = candidate.content.parts;
  return Array.isArray(parts) ? parts.filter(isRecord) : [];
}

/** Maps a Gemini HTTP error to a user-safe ChatError. The upstream body is never forwarded. */
export function mapUpstreamError(status: number): ChatError {
  if (status === 429) {
    return new ChatError(429, "rate_limited", "Gemma quota exceeded; try again shortly");
  }
  if (status === 401 || status === 403) {
    return new ChatError(502, "upstream_error", "The backend's model credentials were rejected");
  }
  if (status === 400) {
    return new ChatError(502, "upstream_error", "The model rejected the request");
  }
  return new ChatError(502, "upstream_error", `The model service failed (HTTP ${status})`);
}

// --- Handler ---------------------------------------------------------------

export interface GemmaEnv {
  GEMINI_API_KEY?: string;
  GEMMA_SYSTEM_PROMPT_MODE?: string;
}

export interface ChatHandlerOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Aborts the upstream call, e.g. when the client disconnects. */
  signal?: AbortSignal;
  /** Filled with non-sensitive request facts for logging. */
  meta?: { imageCount?: number; imageBytes?: number; stream?: boolean };
}

export async function handleGemmaChat(
  request: Request,
  env: GemmaEnv,
  options: ChatHandlerOptions = {}
): Promise<Response> {
  try {
    return await handleGemmaChatOrThrow(request, env, options);
  } catch (error) {
    if (error instanceof ChatError) {
      return errorResponse(error.status, error.type, error.message);
    }
    throw error;
  }
}

async function handleGemmaChatOrThrow(
  request: Request,
  env: GemmaEnv,
  options: ChatHandlerOptions
): Promise<Response> {
  if (!env.GEMINI_API_KEY) {
    throw new ChatError(503, "not_configured", "The chat backend is missing its model credentials");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > CHAT_LIMITS.maxBodyBytes) {
    throw tooLarge();
  }
  const rawBody = await request.arrayBuffer();
  if (rawBody.byteLength > CHAT_LIMITS.maxBodyBytes) {
    throw tooLarge();
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    throw invalid("Request body is not valid JSON");
  }

  const systemPromptMode: SystemPromptMode =
    env.GEMMA_SYSTEM_PROMPT_MODE === "instruction" ? "instruction" : "prepend";
  const translated = translateChatRequest(parsedBody, systemPromptMode);

  if (options.meta) {
    options.meta.imageCount = translated.imageCount;
    options.meta.imageBytes = translated.imageBytes;
    options.meta.stream = translated.stream;
  }

  // Aborts the upstream call when the client disconnects or the stream is cancelled.
  const upstreamAbort = new AbortController();
  if (options.signal?.aborted) upstreamAbort.abort();
  options.signal?.addEventListener("abort", () => upstreamAbort.abort(), { once: true });

  const upstreamResponse = await callGemini(
    translated.stream ? "streamGenerateContent" : "generateContent",
    translated.geminiRequest,
    env.GEMINI_API_KEY,
    options,
    upstreamAbort.signal
  );
  if (!upstreamResponse.ok) {
    await upstreamResponse.body?.cancel();
    throw mapUpstreamError(upstreamResponse.status);
  }

  if (translated.stream) {
    if (!upstreamResponse.body) {
      throw new ChatError(502, "upstream_error", "The model returned an unreadable response");
    }
    return new Response(geminiSseToAnthropicSse(upstreamResponse.body, upstreamAbort), {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-clicky-model": GEMMA_MODEL,
      },
    });
  }

  let geminiJson: unknown;
  try {
    geminiJson = await upstreamResponse.json();
  } catch {
    throw new ChatError(502, "upstream_error", "The model returned an unreadable response");
  }

  const text = extractVisibleText(geminiJson);
  if (text.length === 0) {
    throw new ChatError(502, "upstream_error", "The model returned no answer");
  }

  return new Response(
    JSON.stringify({ model: GEMMA_MODEL, content: [{ type: "text", text }] }),
    {
      status: 200,
      headers: { "content-type": "application/json", "x-clicky-model": GEMMA_MODEL },
    }
  );
}

async function callGemini(
  method: "generateContent" | "streamGenerateContent",
  geminiRequest: GeminiRequest,
  apiKey: string,
  options: ChatHandlerOptions,
  abortSignal: AbortSignal
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = method === "streamGenerateContent" ? "?alt=sse" : "";
  // The timeout also bounds reading the streamed body, not just the headers.
  const signal = AbortSignal.any([
    abortSignal,
    AbortSignal.timeout(options.timeoutMs ?? CHAT_LIMITS.upstreamTimeoutMs),
  ]);
  try {
    return await fetchImpl(`${GEMINI_API_BASE}/${GEMMA_MODEL}:${method}${query}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(geminiRequest),
      signal,
    });
  } catch (error) {
    throw upstreamFailure(error);
  }
}

function upstreamFailure(error: unknown): ChatError {
  if (error instanceof Error && error.name === "TimeoutError") {
    return new ChatError(504, "upstream_timeout", "The model took too long to respond");
  }
  return new ChatError(502, "upstream_error", "Could not reach the model service");
}

// --- Streaming -------------------------------------------------------------

/**
 * Incremental SSE parser. Accepts bytes split at arbitrary boundaries
 * (including inside multi-byte characters and CRLF pairs) and calls
 * `onData` once per complete event with its joined data lines.
 */
export function createSseParser(onData: (data: string) => void) {
  const decoder = new TextDecoder();
  let buffer = "";

  const drain = () => {
    // A trailing lone "\r" stays in the buffer until its "\n" arrives.
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (dataLines.length > 0) onData(dataLines.join("\n"));
    }
  };

  return {
    push(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true });
      drain();
    },
    end() {
      buffer += decoder.decode() + "\n\n";
      drain();
    },
  };
}

const encoder = new TextEncoder();

function sseEvent(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseError(error: ChatError): Uint8Array {
  return sseEvent({ type: "error", error: { type: error.type, message: error.message } });
}

/**
 * Re-emits Gemini streamGenerateContent SSE as the Anthropic
 * content_block_delta events ClaudeAPI.swift parses. Text is forwarded as
 * soon as each upstream event completes; reads are pull-driven so a slow
 * client applies backpressure to the upstream connection.
 */
export function geminiSseToAnthropicSse(
  upstreamBody: ReadableStream<Uint8Array>,
  upstreamAbort: AbortController
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  let pending: Uint8Array[] = [];
  let emittedText = false;
  let failed = false;

  const parser = createSseParser((data) => {
    if (failed) return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      failed = true;
      pending.push(sseError(new ChatError(502, "upstream_error", "The model returned an unreadable response")));
      return;
    }
    if (isRecord(event) && event.error !== undefined) {
      failed = true;
      const status = isRecord(event.error) && typeof event.error.code === "number" ? event.error.code : 500;
      pending.push(sseError(mapUpstreamError(status)));
      return;
    }
    const text = extractVisibleText(event);
    if (text.length > 0) {
      emittedText = true;
      pending.push(sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
    }
  });

  const finish = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (!failed) {
      controller.enqueue(
        emittedText
          ? sseEvent({ type: "message_stop" })
          : sseError(new ChatError(502, "upstream_error", "The model returned no answer"))
      );
    }
    controller.close();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (pending.length === 0) {
          const { done, value } = await reader.read();
          if (done) {
            parser.end();
            for (const chunk of pending) controller.enqueue(chunk);
            pending = [];
            finish(controller);
            return;
          }
          parser.push(value);
          if (failed) break;
        }
      } catch (error) {
        if (!failed) {
          failed = true;
          pending.push(sseError(upstreamFailure(error)));
        }
      }

      for (const chunk of pending) controller.enqueue(chunk);
      pending = [];
      if (failed) {
        upstreamAbort.abort();
        reader.cancel().catch(() => {});
        controller.close();
      }
    },
    cancel() {
      upstreamAbort.abort();
      return reader.cancel().catch(() => {});
    },
  });
}

// --- Helpers ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): ChatError {
  return new ChatError(400, "invalid_request", message);
}

function tooLarge(): ChatError {
  return new ChatError(
    413,
    "payload_too_large",
    `Request body must be at most ${CHAT_LIMITS.maxBodyBytes / (1024 * 1024)} MB`
  );
}
