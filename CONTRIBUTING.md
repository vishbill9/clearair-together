# Contributing

## Set up

```bash
npm ci
cp .env.example .env     # see docs/SETUP.md
npm run db:migrate
npm run dev
```

Tests need a PostgreSQL server; set `TEST_DATABASE_URL` (each test file creates and drops its own database).

## Before you push

```bash
npm run check            # typecheck, lint, format, secret scan, tests with coverage thresholds
npm run test:browser     # Playwright and axe, desktop and mobile
```

CI runs the same steps and the build fails on any error.

## Conventions

- **Structure.** One route module per feature in `src/routes/`. Handlers stay thin: validate with Zod, authorize, call a
  service, return `ok(...)`. Business rules live in pure functions (`src/domain/`) with unit tests.
- **Limits.** Complexity ≤ 10, functions ≤ 60 lines, files ≤ 300 lines, ≤ 4 parameters (use an options object).
  ESLint enforces these; split code rather than disabling a rule.
- **Errors.** Throw `AppError` with a public message. Never put user text, model output, tokens or keys in logs or
  error details.
- **Air-quality data.** Only `src/google/` may produce readings. Never add a fallback number or an estimate.
- **AI output.** Treat it as untrusted input: validate with a schema and run the safety policy before showing it.
- **Frontend.** Build DOM with `h()` from `public/js/dom.js`; never use `innerHTML`. Keep CSS in `public/styles.css`
  (the CSP forbids inline styles and scripts).
- **Tests.** Add a test with every behaviour change. Prefer the app-level harness (`test/helpers/app.ts`) with stubbed
  outside services over mocking internal modules.
- **Commits.** Small, focused commits with a message that says why.
