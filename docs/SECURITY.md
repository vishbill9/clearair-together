# Security

| Risk                | Control                                                                                                                            | Test                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Key exposure        | Keys only in server env; browser never calls Google/Ollama/Anthropic/Gemini; Pino redaction paths; key never in thrown errors             | `security.test.ts` (redaction), `google-client.test.ts` (no key leak), e2e "keeps server keys out of the browser" |
| Silent fake data    | Single source, `unavailable`/`not_configured` states, DB check on `source`                                                         | `google-service.test.ts`, `api.test.ts`, e2e unavailable state                                                    |
| Object-level access | Every household/recommendation/image/reading query is owner-scoped in SQL; non-owners get 404                                      | `api.test.ts`, `indoor.test.ts`, `live.test.ts`                                                                   |
| CSRF                | Signed double-submit token + `Origin` check on all mutating routes; WebSocket requires origin, token and session before upgrade    | `security.test.ts`, `live.test.ts`                                                                                |
| Sessions            | HMAC-signed, expiring, `HttpOnly`, `SameSite=Lax`, `Secure` in production                                                          | `security.test.ts`                                                                                                |
| XSS                 | Strict CSP (`script-src 'self'`, no `unsafe-*`), UI builds DOM with `textContent` only                                             | `security.test.ts`, axe/e2e                                                                                       |
| Clickjacking        | CSP `frame-ancestors 'self'` plus an explicit allowlist (`FRAME_ANCESTORS`) for a required preview host                            | `security.test.ts`                                                                                                |
| Injection           | Zod strict schemas (unknown fields rejected), Drizzle parameterized SQL, UUID params                                               | `api.test.ts`                                                                                                     |
| SSRF / open proxy   | No route takes a URL; Google base URL locked to `airquality.googleapis.com` in production; `redirect: 'error'` on upstream fetches | `config.test.ts`, `security.test.ts`                                                                              |
| Abuse               | Per-IP/user rate limits, tighter on assistant/vision/sensor; body, response, image and session size/time limits                    | `security.test.ts`, `live.test.ts`, `indoor.test.ts`                                                              |
| Uploads             | Magic-byte sniffing, byte and pixel limits, EXIF/GPS stripped by re-encode, ephemeral by default, AES-256-GCM at rest with consent | `indoor.test.ts`                                                                                                  |
| Prompt injection    | User text and image content treated as data; deterministic post-model policy; unknown citations rejected                           | `ai-safety.test.ts`, `assistant-api.test.ts`, `indoor.test.ts`                                                    |
| Privacy             | Coordinates rounded to ~1 km, no names or health data stored, audit `client_hash` instead of IP, k-anonymity (k=5)                 | `community-db.test.ts`                                                                                            |
| Supply chain        | Lockfile, `npm audit` (runtime deps fail on high), secret scan and gitleaks in CI                                                  | `.github/workflows/ci.yml`                                                                                        |

Known dev-only advisory: `drizzle-kit` pulls a deprecated `@esbuild-kit/*` chain flagged for an esbuild dev-server issue
(moderate). It is used only to generate migrations, is not installed in production images, and is not reachable at runtime.

## Accounts

- Sign-up upgrades the current anonymous user in place, so households saved before sign-up are kept. Email is stored lower-cased and unique.
- Passwords are hashed with scrypt (N=16384, r=8, p=1, per-user salt) and never returned or logged. Login does the same work whether or not the email exists and returns one generic error, so it does not reveal which emails are registered.
- `/api/v1/auth/*` is limited to 10 requests per minute per IP, on top of the global limit. All auth writes need the CSRF token like every other mutating route.
- Sign-out clears the session cookie. Tests: `test/auth.test.ts`, e2e "sign up, see the account menu, sign out and back in".
- Not included yet: password reset by email, email verification and account deletion. Add them before opening sign-up to the public.
