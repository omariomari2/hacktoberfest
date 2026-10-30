/**
 * Real Gemma screenshot smoke test.
 *
 * Draws a harmless synthetic "screen" (white canvas with one red button at a
 * known position), sends it through the same handler the backend uses, and
 * prints the answer plus any POINT tag so coordinates can be checked.
 *
 * Reads GEMINI_API_KEY from the environment; never prints it.
 *
 *   node --env-file-if-exists=.env scripts/smoke-gemma.ts [prepend|instruction]
 */

import { deflateSync } from "node:zlib";
import { handleGemmaChat } from "../src/gemma.ts";

const WIDTH = 640;
const HEIGHT = 400;
const BUTTON = { left: 440, top: 260, right: 600, bottom: 340 };

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function drawTestScreen(): Buffer {
  const rowBytes = 1 + WIDTH * 3;
  const pixels = Buffer.alloc(rowBytes * HEIGHT, 0xff);
  for (let y = 0; y < HEIGHT; y++) {
    pixels[y * rowBytes] = 0; // filter: none
    for (let x = 0; x < WIDTH; x++) {
      const insideButton = x >= BUTTON.left && x < BUTTON.right && y >= BUTTON.top && y < BUTTON.bottom;
      if (insideButton) {
        const offset = y * rowBytes + 1 + x * 3;
        pixels[offset] = 0xdc;
        pixels[offset + 1] = 0x26;
        pixels[offset + 2] = 0x26;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const mode = process.argv[2] === "instruction" ? "instruction" : "prepend";
console.log(`GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? "set" : "NOT SET"}; system prompt mode: ${mode}`);

const body = {
  model: "ignored-by-server",
  max_tokens: 512,
  stream: false,
  system:
    "You help users find things on their screen. Answer in one short sentence. " +
    "When you refer to an element, append [POINT:x,y:label:screen1] using pixel " +
    `coordinates in the screenshot (origin top-left, ${WIDTH}x${HEIGHT}).`,
  messages: [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: drawTestScreen().toString("base64") } },
        { type: "text", text: `screen1 (primary, ${WIDTH}x${HEIGHT})` },
        { type: "text", text: "What color is the only button on screen, and where is it?" },
      ],
    },
  ],
};

const started = Date.now();
const response = await handleGemmaChat(
  new Request("http://localhost/chat", { method: "POST", body: JSON.stringify(body) }),
  { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GEMMA_SYSTEM_PROMPT_MODE: mode }
);
const result = await response.json();
console.log(`HTTP ${response.status} in ${Date.now() - started} ms, model header: ${response.headers.get("x-clicky-model")}`);
console.log(JSON.stringify(result, null, 2));

const text: string = result?.content?.[0]?.text ?? "";
const point = text.match(/\[POINT:(\d+),(\d+):[^\]]*\]/);
if (point) {
  const [x, y] = [Number(point[1]), Number(point[2])];
  const inside = x >= BUTTON.left && x < BUTTON.right && y >= BUTTON.top && y < BUTTON.bottom;
  console.log(`POINT (${x}, ${y}) ${inside ? "is inside" : "is OUTSIDE"} the button ${JSON.stringify(BUTTON)}`);
} else {
  console.log("No POINT tag in the answer");
}
process.exitCode = response.ok ? 0 : 1;
