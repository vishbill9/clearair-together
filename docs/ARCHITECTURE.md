# Architecture

ClearAir Together is one Node.js service (Fastify, TypeScript strict) that serves a JSON API and a static,
framework-free frontend. PostgreSQL stores households, plans, accounts and cached readings.

```
Browser (public/js, ES modules)
   │  JSON over HTTPS, CSRF header        │  WSS (voice)
   ▼                                      ▼
Fastify ── security/plugin.ts (CSP, CORS, rate limit, CSRF)
   │
   ├── routes/*            one module per feature; validate with Zod, call services, return the envelope
   ├── live/voice.ts       admission checks, then live/session.ts proxies audio to Gemini Live
   │
   ├── google/             the only producer of air-quality values (client → normalize → service + cache)
   ├── ai/                 providers (Ollama, Anthropic, Gemini) behind one interface, safety policy, assistant
   ├── domain/             pure rules: daily plan, routine comparison (no I/O)
   ├── plants/             catalog and the plant chat
   └── repo.ts, db/        Drizzle schema, migrations, ownership-checked queries
```

## Request flow

1. `security/plugin.ts` sets headers, enforces CORS and rate limits, and checks the double-submit CSRF token on writes.
2. A route parses input with a strict Zod schema (`routes/validate.ts`). Unknown fields are rejected.
3. Ownership is checked in code (`routes/shared.ts: loadOwnedHousehold`) as well as by row-level security in Postgres.
4. Services do the work. Air quality always comes from `AirQualityService`, which returns `snapshot: null` whenever real
   data cannot be shown, together with a `status` the UI must display.
5. Every response uses the envelope `{ requestId, schemaVersion, data | error }`. `error-handler.ts` maps any thrown
   error to a safe public message; unknown errors are logged without user content.

## Module responsibilities

| Area        | Files                                                       | Responsibility                                                                        |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Composition | `app.ts`, `server.ts`, `config.ts`                          | Build services from validated config (or test seams); fail fast in production         |
| HTTP        | `routes/*.ts`, `error-handler.ts`, `envelope.ts`            | Thin handlers: validate, authorize, call a service, shape the response                |
| Air quality | `google/client.ts`, `normalize.ts`, `service.ts`            | Call Google, normalize, cache, and report honest freshness states                     |
| AI          | `ai/http.ts`, `ollama.ts`, `anthropic.ts`, `gemini-text.ts` | One `AiProvider` interface; shared timeout and error mapping in `http.ts`             |
| AI safety   | `ai/schema.ts`, `ai/safety.ts`, `ai/emergency.ts`           | Schema-validate model output, then a deterministic policy; emergencies skip the model |
| Rules       | `domain/plan.ts`, `domain/impact.ts`, `google/severity.ts`  | Pure functions, fully unit-tested                                                     |
| Voice       | `live/voice.ts`, `live/session.ts`, `live/protocol.ts`      | Admission, verified context, and a proxied session with time and safety limits        |
| Accounts    | `routes/auth.ts`, `routes/google-login.ts`, `security/*`    | scrypt passwords, signed session cookie, Google OAuth with PKCE, state and nonce      |
| Frontend    | `public/js/*.js`                                            | One module per view; `dom.js` builds elements without `innerHTML`                     |

## Design decisions

- **No invented data.** Only `google/` produces air-quality values. Without a verified snapshot the API returns `null`
  and a reason; the UI shows that state and no numbers.
- **Exposure and emissions stay separate.** Every comparison reports both, because they often disagree.
- **Model output is untrusted.** It is parsed, validated against a schema, checked by `ai/safety.ts`, and replaced with a
  safe reply if any rule fails. Urgent symptoms are answered with fixed guidance before any model call.
- **Test seams, not mocks of internals.** `buildApp` accepts fetch functions and providers, so tests exercise the real
  routes, database and safety code with only the outside services stubbed.
- **No frontend framework.** The page is small; ES modules with a strict CSP (no inline script or style) keep the attack
  surface and the bundle at zero build steps.

## Quality gates

Enforced on every push by CI (`.github/workflows/ci.yml`):

- TypeScript strict for the server and type-checked JavaScript for the browser (`npm run typecheck`).
- ESLint with size and complexity limits for application code: cyclomatic complexity ≤ 10, functions ≤ 60 lines,
  files ≤ 300 lines, ≤ 4 parameters, nesting ≤ 3.
- Prettier formatting, an offline secret scan plus gitleaks, and `npm audit` for runtime dependencies.
- Unit and integration tests on real PostgreSQL with coverage thresholds (lines 95%, branches 85%, functions 90%).
- Playwright flows with axe accessibility checks on desktop and mobile.
