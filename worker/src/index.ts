/**
 * Clicky Proxy Worker
 *
 * Proxies requests to Gemma and ElevenLabs APIs so the app never
 * ships with raw API keys. Keys are stored as Cloudflare secrets.
 *
 * Routes:
 *   POST /chat  → Gemini API pinned to Gemma (see src/gemma.ts)
 *   POST /tts   → ElevenLabs TTS API
 *
 * The DigitalOcean deployment uses src/main.ts (Node) instead, which adds
 * app-token auth and concurrency limits. This Worker entry has no auth.
 */

import { handleGemmaChat, type GemmaEnv } from "./gemma.ts";
import { handleTTS, handleTranscribeToken, type SpeechEnv } from "./speech.ts";

interface Env extends GemmaEnv, SpeechEnv {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      if (url.pathname === "/chat") {
        return await handleGemmaChat(request, env);
      }

      if (url.pathname === "/tts") {
        return await handleTTS(request, env);
      }

      if (url.pathname === "/transcribe-token") {
        return await handleTranscribeToken(env);
      }
    } catch (error) {
      console.error(`[${url.pathname}] Unhandled error:`, error);
      return new Response(
        JSON.stringify({ error: String(error) }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },
};
