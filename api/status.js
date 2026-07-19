import { getQboTokens, getQbTimeTokens } from '../lib/kv.js';

export const config = { runtime: 'edge' };

/**
 * Cheap, no-external-API-call health snapshot for the dashboard-wide issue
 * banner (see checkDashboardStatus in index.html). Only reads what's
 * already stored in Redis -- never calls QuickBooks or QuickBooks Time
 * itself, so this is safe to poll on every page load and on the regular
 * refresh timer without touching either service's rate limits.
 *
 * QBO's own reauth_required detection already happens inside the real
 * data-fetching endpoints (summary.js, clients.js, etc) when a stored
 * refresh token turns out to be dead -- this endpoint doesn't duplicate
 * that live check, it just reports whether a connection is stored at all.
 *
 * QuickBooks Time's token doesn't carry its own expiration date within
 * the token itself (the "Add Token" web-UI shortcut doesn't expose that
 * via the API), so tokenExpiresAt is sourced from QBTIME_TOKEN_EXPIRES_AT,
 * an env var set manually whenever the token is generated or renewed on
 * the QuickBooks Time API Add-On page.
 */
export default async function handler(request) {
  const [qboTokens, qbTimeTokens] = await Promise.all([
    getQboTokens(),
    getQbTimeTokens(),
  ]);

  const qbTimeExpiresAt = process.env.QBTIME_TOKEN_EXPIRES_AT || null;

  return new Response(
    JSON.stringify({
      qbo: {
        connected: Boolean(qboTokens),
      },
      qbtime: {
        connected: Boolean(qbTimeTokens),
        tokenExpiresAt: qbTimeTokens ? qbTimeExpiresAt : null,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
