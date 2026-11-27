/**
 * Test-only server for Playwright. It runs the real app against a real, migrated Postgres database,
 * and replaces ONLY the upstream network calls (Google, Anthropic, Gemini text) with deterministic stubs.
 * Latitude 0.01 simulates a Google outage so the "unavailable" state can be exercised.
 */
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createTestDb } from '../test/helpers/db.js';
import { currentBody, jsonResponse } from '../test/helpers/google-fixtures.js';

const port = Number(process.env.E2E_PORT ?? 3100);
const tdb = await createTestDb();
const config = loadConfig(
  {
    NODE_ENV: 'test',
    PORT: String(port),
    APP_ORIGIN: `http://localhost:${port}`,
    DATABASE_URL: tdb.url,
    SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret-1234',
    GOOGLE_AIR_QUALITY_API_KEY: 'e2e-google',
    ANTHROPIC_API_KEY: 'e2e-anthropic',
    GOOGLE_GEMINI_API_KEY: 'e2e-gemini',
    LOG_LEVEL: 'silent',
    AIR_QUALITY_CACHE_TTL_SECONDS: '60',
  } as NodeJS.ProcessEnv,
  () => undefined,
);

const { app } = await buildApp({
  config,
  dbh: tdb,
  googleFetch: async (_url, init) => {
    const body = JSON.parse(String(init.body));
    if (body.location.latitude === 0.01) return jsonResponse({}, 503);
    return jsonResponse(currentBody());
  },
  aiProvider: {
    name: 'e2e-stub',
    async generate() {
      return JSON.stringify({
        directAnswer: 'Consider moving a long run to a cleaner time or indoors today.',
        recommendedActions: [
          { title: 'Shift your run', detail: 'Check the forecast for a cleaner window.', effort: 'low' },
        ],
        effortLevel: 'low',
        rationale: 'Readings are elevated, so strenuous effort outdoors raises how much you breathe in.',
        feasibleAlternative: 'A short easy walk is a lighter option.',
        exposureOpportunity: 'lower',
        emissionsOpportunity: 'similar',
        assumptions: ['You can reschedule.'],
        safetyNotice: 'This is general guidance, not medical advice.',
        sources: [{ id: 'g-timing' }],
        uncertainty: 'Conditions can change within hours.',
      });
    },
  },
});
await app.listen({ port, host: '127.0.0.1' });
const stop = async () => {
  await app.close();
  await tdb.drop();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
