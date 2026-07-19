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
 * QuickBooks Time's manually-seeded "Add Token" shortcut has no
 * refresh_token and a fixed expiration date tracked only via the
 * QBTIME_TOKEN_EXPIRES_AT env var (set whenever that token is generated
 * or renewed). Once connected via the real OAuth flow instead (see
 * api/auth/qbtime/connect.js), the stored token has a refresh_token and
 * renews itself automatically -- no manual-expiration warning applies to
 * that case, so tokenExpiresAt is only surfaced for the legacy path.
 */
export default async function handler(request) {
  const [qboTokens, qbTimeTokens] = await Promise.all([
    getQboTokens(),
    getQbTimeTokens(),
  ]);

  const hasAutoRefresh = Boolean(qbTimeTokens?.refresh_token);
  const qbTimeExpiresAt = !hasAutoRefresh ? (process.env.QBTIME_TOKEN_EXPIRES_AT || null) : null;

  return new Response(
    JSON.stringify({
      qbo: {
        connected: Boolean(qboTokens),
      },
      qbtime: {
        connected: Boolean(qbTimeTokens),
        autoRefreshing: hasAutoRefresh,
        tokenExpiresAt: qbTimeTokens ? qbTimeExpiresAt : null,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
