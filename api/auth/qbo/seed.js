import { setQbTimeTokens } from '../../../lib/kv.js';

export const config = { runtime: 'edge' };

/**
 * One-time setup: reads the QuickBooks Time access token (from "Add Token"
 * on the QuickBooks Time API Add-On settings page) from an environment
 * variable and stores it in Redis.
 *
 * There's no refresh_token with this token type -- it has a fixed
 * expiration date, extendable manually on that same settings page. When it
 * expires, team-hours.js will start returning `reauth_required`; generate
 * a new token, update QBTIME_SEED_ACCESS_TOKEN in Vercel, and re-visit this
 * endpoint to reseed.
 *
 * Already covered by the site-wide session check in middleware.js like
 * every other /api/ route, so it's not separately exposed. Safe to hit
 * more than once -- it always just overwrites the stored token.
 */
export default async function handler(request) {
  const seedAccessToken = process.env.QBTIME_SEED_ACCESS_TOKEN;

  if (!seedAccessToken) {
    return new Response(
      JSON.stringify({ seeded: false, error: 'missing_env_var', missing: ['QBTIME_SEED_ACCESS_TOKEN'] }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  await setQbTimeTokens({ access_token: seedAccessToken, seeded_at: Date.now() });

  return new Response(
    JSON.stringify({ seeded: true }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
