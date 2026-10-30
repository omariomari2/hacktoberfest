/**
 * Production entry point: `node src/main.ts`.
 * Configuration comes from the environment only (see .env.example).
 */

import { createClickyServer } from "./server.ts";

const port = Number(process.env.PORT ?? 8787);

const server = createClickyServer({
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMMA_SYSTEM_PROMPT_MODE: process.env.GEMMA_SYSTEM_PROMPT_MODE,
  CLICKY_APP_TOKEN: process.env.CLICKY_APP_TOKEN,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
  ASSEMBLYAI_API_KEY: process.env.ASSEMBLYAI_API_KEY,
});

// Report which settings are present, never their values.
const configured = ["GEMINI_API_KEY", "CLICKY_APP_TOKEN", "ELEVENLABS_API_KEY", "ASSEMBLYAI_API_KEY"]
  .map((name) => `${name}=${process.env[name] ? "set" : "unset"}`)
  .join(" ");

server.listen(port, () => {
  console.log(`clicky backend listening on :${port} (${configured})`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`${signal} received; closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
