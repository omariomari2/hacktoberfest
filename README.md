# HeyCoach

A macOS screen companion powered by Gemma. Hold **Control + Option**, say **Hey Coach**, and ask about what is on your screen. HeyCoach explains and points to relevant controls.

## Run on your Mac

Follow [setup.md](setup.md) for prerequisites, permissions, backend configuration, and the Xcode GUI workflow.

```bash
git clone https://github.com/omariomari2/hacktoberfest.git
cd hacktoberfest
open leanring-buddy.xcodeproj
```

Keep the legacy `leanring-buddy` scheme. The built app is **HeyCoach.app**. Activation remains push-to-talk; continuous wake-word listening is not implemented.

## Services

- **Gemma:** hosted screen understanding through the Gemini API.
- **DigitalOcean:** authenticated Node backend with streamed responses.
- **Snowflake:** planned project data integration; runtime connectivity remains unverified.

Backend URL: `https://coach.167.71.143.67.sslip.io`. Share the app token privately. Provider keys stay on the server; never commit secrets. Voice-provider configuration and Mac end-to-end testing remain required. Computer use is being reviewed separately and is not in the merged baseline.

## Development

See [tasks/contract.md](tasks/contract.md) for the API contract. Use the Node entry point in `worker/` for DigitalOcean, rather than the legacy Cloudflare entry point.

```bash
cd worker
npm ci
npm test
npm run typecheck
node --env-file=.env src/main.ts
```

Requires Node 22.18 or newer. Configuration names are in `worker/.env.example`. Build and test the native app through the Xcode GUI.

## Credits and license

HeyCoach is a hackathon adaptation of [Clicky by Farza and contributors](https://github.com/farzaa/clicky), released under the [MIT license](LICENSE). Preserve the upstream copyright and license notices. Upstream HeyClicky downloads are a separate product.
