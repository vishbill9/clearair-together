# Testing and verification status

## What runs

- `npm test`: 167 `node:test` tests on **real PostgreSQL**, one temporary database per file. Stubs replace every outside
  service. Files: Google request building, normalization and pagination (`google-client`), freshness states
  (`google-service`), AI schema and safety policy (`ai-safety`, `assistant-api`), plant chat and its safety rules
  (`plants`), provider fallback (`fallback`), accounts (`auth`), Google sign-in (`google-login`), authorization
  isolation and household flows (`api`), security headers, CORS, CSRF, rate limits and redaction (`security`),
  configuration rules (`config`), emissions versus exposure logic (`domain`), community k-anonymity
  (`community-db`), the live-voice proxy against a local fake Gemini WebSocket server (`live`), and provider selection,
  HTTP error mapping, public error mapping, forecast windows, severity bands and plan rules (`units`).
- `npm run test:coverage`: the same suite with enforced thresholds. Current coverage of `src/`: 98.5% of lines,
  90.5% of branches, 93.7% of functions.
- `npm run test:browser`: 15 Playwright tests on desktop and mobile (30 runs): location, real-data status and provenance,
  unavailable state, household and routine comparison, assistant, community suppression, keys kept out of the browser,
  axe (WCAG 2 A/AA), keyboard order, 360px width, sign-up and sign-in, menu and sky, Google button states, plants.

## Not verified against live services

The sandbox this was built in had no Google, Ollama, Anthropic or Gemini credentials and no route to those APIs. Their behaviour is
tested with stubs that follow the documented request/response shapes. Before launch, with real keys, please check:

1. **Google Air Quality**: request and response shapes (`currentConditions:lookup`, `forecast:lookup`), index codes and
   categories for your regions, and that `languageCode`/`extraComputations` are accepted for your key.
2. **Ollama Cloud / Anthropic**: the `OLLAMA_MODEL` tag (default `gemma4:31b`) or `AI_MODEL` id is valid for your account and the model reliably returns the JSON contract (Ollama cloud has no structured-output mode, so this depends on prompting). Failures
   surface as `ai_bad_output` and never as unvalidated text.
3. **Gemini Live**: the proxy follows the public Live API WebSocket protocol (`setup`, `setupComplete`,
   `realtimeInput.audio` as 16 kHz PCM, 24 kHz audio out, input/output transcription). Key passing (`?key=`), audio MIME
   type and model names were not confirmed against the live service. Also, audio cannot be recalled once played, so the
   transcript safety check can end a session but cannot unsay a sentence already spoken.
4. **Plant chat (Gemini text)**: seen working on Render with `gemini-3.5-flash-lite`, but some replies take longer than 12 seconds, so the chat then falls back to the assistant model. Watch the `plant chat falling back` log line.
5. A real browser microphone pass on a phone (the e2e suite stubs the model and does not open the mic).
