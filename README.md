# ClearAir Together

Household air-quality guidance built on **verified data only**. Every air-quality value comes from the
[Google Air Quality API](https://developers.google.com/maps/documentation/air-quality), called server-side. If the
data is missing, stale or the provider is down, the app says so and shows no numbers. It never invents a reading.

- **Exposure and emissions are separate.** Every recommendation and routine comparison shows what you breathe and what your choice puts in the air as independent columns, because they often disagree.
- **Honest states.** `fresh`, `cached`, `stale`, `unavailable`, `not_configured`. Each one is visible in the UI and the API.
- **Safety-checked AI.** The assistant (Ollama Cloud Gemma, or Anthropic Claude) gets structured, verified context. Its JSON output is schema-validated and then passed through a deterministic safety policy before anyone sees it.
- **Private by default.** Rounded coordinates, age groups instead of identities, k-anonymous community totals, no stored audio.

## Quick start

Requirements: Node 22+, PostgreSQL 15+ (Supabase recommended, Neon works).

```bash
npm ci
cp .env.example .env        # fill in values; see docs/SETUP.md
npm run db:migrate          # applies drizzle/ migrations (DATABASE_URL required)
npm run dev                 # http://localhost:3000
```

With no keys the app still runs in development and shows explicit "not configured" states. In `NODE_ENV=production`
it refuses to start unless `DATABASE_URL`, `GOOGLE_AIR_QUALITY_API_KEY`, an assistant key (`OLLAMA_API_KEY`, or `ANTHROPIC_API_KEY`) and a 32+ character
`SESSION_SECRET` are set.

## Scripts

| Script                                        | What it does                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev` / `build` / `start`             | Develop with reload, compile to `dist/`, run compiled server                                                              |
| `npm run typecheck` / `lint` / `format:check` | TypeScript strict (server) and checked JS (browser), ESLint with complexity limits, Prettier                              |
| `npm test`                                    | `node:test` suite against real Postgres (`TEST_DATABASE_URL`, default `postgres://postgres@127.0.0.1:5544/clearair_test`) |
| `npm run test:coverage`                       | Same suite with coverage thresholds (lines 95%, branches 85%, functions 90%)                                              |
| `npm run check`                               | Every pre-push check in one command                                                                                       |
| `npm run test:browser`                        | Playwright flows plus axe accessibility scan, desktop and mobile                                                          |
| `npm run audit` / `audit:all`                 | `npm audit` for runtime deps (fails on high) / everything                                                                 |
| `npm run secrets:scan`                        | Offline secret scan (CI also runs gitleaks)                                                                               |
| `npm run db:generate` / `db:migrate`          | Drizzle migrations                                                                                                        |

## API (all under `/api/v1`, envelope `{requestId, schemaVersion, data | error}`)

| Route                                                                                      | Purpose                                                                    |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `GET /health` (outside `/api/v1`)                                                          | Liveness, database state, integration flags (no secrets)                   |
| `GET /air-quality?lat&lng`                                                                 | Current snapshot plus `status`, provenance and timestamps                  |
| `GET /air-quality/forecast?lat&lng&start&end`                                              | Hourly forecast (paginated upstream, deduped, UTC)                         |
| `POST /households`, `GET /households/:id`, `PUT /households/:id/constraints`               | Household profile (owner only)                                             |
| `POST /households/:id/daily-plan`                                                          | Rules-based plan with indoor quick wins and routines                       |
| `POST /assistant/messages`                                                                 | AI assistant (validated, safety-checked); urgent symptoms bypass the model |
| `POST /scenarios/compare`                                                                  | Routine comparison with separate exposure and emissions                    |
| `POST /recommendations/:id/feedback`                                                       | helpful / not_helpful / done / not_feasible                                |
| `POST /community/challenges`, `POST …/:id/join`, `POST …/:id/actions`, `GET …/:id/summary` | Aggregate-only, k-anonymous (k=5)                                          |
| `WS /live/voice`, `POST /live/voice/stop`                                                  | Optional live voice via a Gemini Live proxy                                |
| `GET /plants`, `POST /plants/chat`                                                         | Houseplant list; Gemini plant chat (falls back to the assistant model)     |
| `POST /auth/register`, `/auth/login`, `/auth/logout`, `GET /auth/me`                       | Email and password accounts                                                |
| `GET /auth/google/start`, `GET /auth/google/callback`                                      | Sign in with Google (authorization code flow with PKCE)                    |
| `GET /config`, `GET /session`                                                              | Public feature flags; session and CSRF token                               |

## How the data rules are enforced

1. **One source.** `src/google/` is the only code that produces air-quality values. Types and a DB check constraint pin `source = 'google_air_quality'`.
2. **No silent fallback.** `AirQualityService` returns `snapshot: null` with a reason when data cannot be shown. A real cached snapshot is reused only inside `AIR_QUALITY_CACHE_TTL_SECONDS` (labelled `cached`) or, when the provider is down, inside `AIR_QUALITY_STALE_MAX_SECONDS` (labelled `stale`).
3. **Keys stay server-side.** The browser calls only this server. Pino redacts keys and cookies, and a test asserts no secret appears in responses or logs.
4. **General guidance is labelled.** Education content carries `basis: "general_guidance"` or comes from an approved, id-addressed list (`src/ai/guidance.ts`).

## Assistant safety policy

`src/ai/safety.ts` blocks, deterministically and after the model: diagnosis, medication changes and dosing, unsupported
certainty or "eliminates risk" claims, AQI numbers not in the verified snapshot (any number when there is none), URLs and
citations outside the approved list, invented phone numbers and local services, ozone generators, indoor burning and
blocked ventilation. Urgent-symptom messages never reach the model and return local emergency wording
(`src/ai/emergency.ts`), stating that this app is not an emergency service. A blocked answer is replaced with a safe
fallback and an audit event is recorded. Live voice applies the same text checks to transcripts and ends the session on a
violation (audio cannot be recalled once played; see limitations).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): modules, request flow, design decisions and quality gates.
- [CONTRIBUTING.md](CONTRIBUTING.md): conventions and the checks to run before pushing.
- [docs/SETUP.md](docs/SETUP.md): Google API enablement, Supabase/Neon, environment variables, deployment.
- [docs/SECURITY.md](docs/SECURITY.md): threat model, controls and their tests.
- [docs/TESTING.md](docs/TESTING.md): what is tested, and what is **not verified against live services**.

## Interface

A menu (top bar on desktop, bottom tabs on phones) switches between Today, Ask & talk, My home, Routines, Plants and Community. The page sky follows the verified air-quality category. Accounts (email and password) keep your home across devices. "Ask & talk" has typed questions with suggested prompts and the Gemini Live voice conversation (when `LIVE_AI_ENABLED` and a Gemini key are set). Fonts (Figtree, Fraunces, SIL OFL) are self-hosted in `public/fonts`.
