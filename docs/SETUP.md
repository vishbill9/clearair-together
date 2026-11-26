# Setup and deployment

## 1. Google Air Quality API key

1. In Google Cloud Console create or choose a project and enable **Air Quality API**.
2. Create an API key. Restrict it to the _Air Quality API_ only. Because the key is used from your server, add an IP
   address restriction for your server's egress IPs where your host provides stable ones.
3. Put it in `GOOGLE_AIR_QUALITY_API_KEY`. It is sent only from the server (`POST https://airquality.googleapis.com/v1/...`).
   Billing must be enabled on the project; check current pricing and quotas in the Cloud Console.

## 2. Anthropic

Create a key in the Anthropic Console and set `ANTHROPIC_API_KEY`. `AI_MODEL` defaults to `claude-3-5-sonnet-latest` as
specified; change it to any current model id your account can use.

## 3. Database (Supabase recommended; Neon works)

- Supabase: Project Settings → Database → connection string. Use the **direct** or **session pooler** string for
  migrations. The app disables prepared statements, so the transaction pooler also works at runtime.
- Run `npm run db:migrate`. Migration `0001_enable_rls.sql` turns on Row Level Security on every table and revokes
  `anon`/`authenticated` access if those roles exist. The Node server connects as the table owner and enforces
  authorization in code (owner-scoped SQL, tested). Never expose these tables through Supabase's public REST/Realtime APIs.
- Set `RUN_MIGRATIONS_ON_START=true` only if you want the server to migrate at boot.

## 4. Environment variables

Names only; see `.env.example` for defaults. Secrets must be set in your host's secret store, never committed.

| Variable                                                                                                                          | Notes                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `NODE_ENV`, `PORT`, `APP_ORIGIN`                                                                                                  | `APP_ORIGIN` must be `https://…` in production; it is also the CSRF/CORS origin                     |
| `DATABASE_URL`, `SESSION_SECRET`                                                                                                  | Required in production; `SESSION_SECRET` 32+ chars (`openssl rand -base64 48`)                      |
| `GOOGLE_AIR_QUALITY_API_KEY`, `ANTHROPIC_API_KEY`                                                                                 | Required in production                                                                              |
| `AI_MODEL`, `AIR_QUALITY_CACHE_TTL_SECONDS` (900), `AIR_QUALITY_STALE_MAX_SECONDS`, `MAX_FORECAST_HOURS` (96)                     | Tuning                                                                                              |
| `CORS_ALLOWED_ORIGINS`, `FRAME_ANCESTORS`                                                                                         | Comma separated. `FRAME_ANCESTORS` lists hosts allowed to embed a preview; default is `'self'` only |
| `TRUST_PROXY`                                                                                                                     | Set `true` behind a reverse proxy so rate limits use the real client IP                             |
| `LIVE_AI_ENABLED`, `GOOGLE_GEMINI_API_KEY`, `GOOGLE_GEMINI_LIVE_MODEL`, `GOOGLE_GEMINI_VISION_MODEL`                              | Optional multimodal module                                                                          |
| `MAX_LIVE_SESSION_SECONDS`, `LIVE_IDLE_TIMEOUT_SECONDS`, `MAX_IMAGE_BYTES`, `MAX_IMAGE_DIMENSION`, `VISION_RATE_LIMIT_PER_MINUTE` | Limits                                                                                              |
| `IMAGE_ENCRYPTION_KEY`, `IMAGE_RETENTION_DAYS`                                                                                    | Base64 32-byte key (`openssl rand -base64 32`). Without it, photos can never be stored              |

## 5. Deploying

Any Node host works (Render, Fly.io, Railway, a VM). Build command `npm ci && npm run build`; start command
`npm start`. Terminate TLS in front of the app and set `APP_ORIGIN` to the https URL; HSTS, `Secure` cookies and
`upgrade-insecure-requests` switch on automatically in production. WebSockets (live voice) must be enabled on the
platform. Run `purgeExpired` (see `src/routes/indoor.ts`) on a schedule if you enable stored photos.
