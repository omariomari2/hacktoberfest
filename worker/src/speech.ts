/**
 * Optional speech routes: ElevenLabs TTS and AssemblyAI streaming tokens.
 * Missing credentials return 503 not_configured so the Mac app can fall
 * back to native speech. Upstream error bodies are never forwarded.
 */

import { errorResponse } from "./gemma.ts";

export interface SpeechEnv {
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_VOICE_ID?: string;
  ASSEMBLYAI_API_KEY?: string;
}

export interface SpeechOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const SPEECH_TIMEOUT_MS = 30_000;

export async function handleTTS(
  request: Request,
  env: SpeechEnv,
  options: SpeechOptions = {}
): Promise<Response> {
  if (!env.ELEVENLABS_API_KEY || !env.ELEVENLABS_VOICE_ID) {
    return errorResponse(503, "not_configured", "Text-to-speech is not configured on this backend");
  }

  const response = await speechFetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API_KEY,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: await request.text(),
    },
    options
  );
  if (response instanceof Error) {
    return errorResponse(502, "upstream_error", "Could not reach the text-to-speech service");
  }
  if (!response.ok) {
    await response.body?.cancel();
    return speechUpstreamError(response.status, "text-to-speech");
  }

  return new Response(response.body, {
    status: 200,
    headers: { "content-type": response.headers.get("content-type") || "audio/mpeg" },
  });
}

export async function handleTranscribeToken(
  env: SpeechEnv,
  options: SpeechOptions = {}
): Promise<Response> {
  if (!env.ASSEMBLYAI_API_KEY) {
    return errorResponse(503, "not_configured", "AssemblyAI transcription is not configured on this backend");
  }

  const response = await speechFetch(
    "https://streaming.assemblyai.com/v3/token?expires_in_seconds=480",
    { method: "GET", headers: { authorization: env.ASSEMBLYAI_API_KEY } },
    options
  );
  if (response instanceof Error) {
    return errorResponse(502, "upstream_error", "Could not reach the transcription service");
  }
  if (!response.ok) {
    await response.body?.cancel();
    return speechUpstreamError(response.status, "transcription");
  }

  return new Response(await response.text(), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function speechFetch(
  url: string,
  init: RequestInit,
  options: SpeechOptions
): Promise<Response | Error> {
  const signals = [AbortSignal.timeout(SPEECH_TIMEOUT_MS)];
  if (options.signal) signals.push(options.signal);
  try {
    return await (options.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.any(signals) });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function speechUpstreamError(status: number, service: string): Response {
  if (status === 429) {
    return errorResponse(429, "rate_limited", `The ${service} quota was exceeded`);
  }
  return errorResponse(502, "upstream_error", `The ${service} service failed (HTTP ${status})`);
}
