# Testing and verification status

## What runs

- `npm test`: 130 `node:test` tests across Google request building/normalization/pagination/failure modes, freshness states,
  AI schema and safety policy, authorization isolation, security headers/CORS/CSRF/rate limits/redaction, emissions vs
  exposure logic, migrations and constraints on **real PostgreSQL**, sensor validation,
  live-voice proxy (against a local fake Gemini WebSocket server).
- `npm run test:browser`: 11 Playwright tests × desktop and mobile: location, real-data status, provenance, unavailable state,
  assistant, feedback, community suppression, keys-not-in-browser, axe (WCAG 2 A/AA), keyboard, 360px width.

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
4. A real browser microphone pass on a phone (the e2e suite stubs the model and does not open the mic).
