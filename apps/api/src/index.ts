import { fileURLToPath } from 'node:url';
import { buildApp, publicOrigin } from './app.js';
import { migrationsDir, openPool, runMigrations } from './db.js';

// dist/index.js and src/index.ts both sit one level below apps/api.
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}. See docs/SETUP.md.`);
  return value;
}

const clientId = required('PAYPAL_CLIENT_ID');
const clientSecret = required('PAYPAL_CLIENT_SECRET');
const ownerPassword = required('OWNER_PASSWORD');
const demoOwnerPassword = required('DEMO_OWNER_PASSWORD');
// The demo password is published for judges, so it must never also open the main stall.
if (ownerPassword === demoOwnerPassword) throw new Error('OWNER_PASSWORD and DEMO_OWNER_PASSWORD must differ.');
const sessionSecret = required('SESSION_SECRET');
const publicBaseUrl = publicOrigin(required('PUBLIC_BASE_URL'));
// The /demo page links to the demo film once this is set. A mistyped value fails the start, so a link to nowhere never ships.
const demoFilmUrl = process.env.DEMO_FILM_URL || undefined;
if (demoFilmUrl && new URL(demoFilmUrl).protocol !== 'https:') throw new Error('DEMO_FILM_URL must be an https URL.');
const demoRepoUrl = process.env.DEMO_REPO_URL || undefined;
if (demoRepoUrl && new URL(demoRepoUrl).protocol !== 'https:') throw new Error('DEMO_REPO_URL must be an https URL.');
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');

// Development only: lets the capture rig rehearse a sale without an Anthropic key. See tools/capture/README.md.
const production = process.env.NODE_ENV === 'production';
const scripted = process.env.STALLKEEPER_SCRIPTED_MODEL === '1';
if (scripted && production) throw new Error('STALLKEEPER_SCRIPTED_MODEL is for development only.');
const model = scripted ? (await import('./scripted-model.js')).scriptedModel() : undefined;
if (scripted) console.warn('Scripted AI model in use. Replies are not from Claude.');

const db = openPool(required('DATABASE_URL'));
await runMigrations(db, migrationsDir);
const app = buildApp({
  supabaseUrl: process.env.SUPABASE_URL, supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  demoBuyerEmail: process.env.DEMO_BUYER_EMAIL, demoBuyerPassword: process.env.DEMO_BUYER_PASSWORD, demoFilmUrl, demoRepoUrl,
  publicBaseUrl, clientId, clientSecret, webhookId: process.env.PAYPAL_WEBHOOK_ID, donateButtonId: process.env.PAYPAL_DONATE_BUTTON_ID, webDist,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY, aiDailyCapUsd: process.env.AI_DAILY_CAP_USD, aiLedgerDailyCapUsd: process.env.AI_LEDGER_DAILY_CAP_USD, agStudioLicenceKey: process.env.AG_STUDIO_LICENCE_KEY, channel3ApiKey: process.env.CHANNEL3_API_KEY,
  ownerPassword, demoOwnerPassword, sessionSecret, production,
  // Render sets RENDER_GIT_COMMIT on each deploy (https://render.com/docs/environment-variables).
  commit: process.env.RENDER_GIT_COMMIT,
}, { db, model, logger: true });
// A dropped idle connection emits here, and an unhandled 'error' event would end the process.
db.on('error', error => { app.log.error({ errorType: error.name }, 'Idle database connection failed'); });
await app.listen({ port, host: '0.0.0.0' });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close().then(() => db.end()); });
