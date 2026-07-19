// Client for the QuickBooks Time API (formerly TSheets).
//
// This is a genuinely separate product from QuickBooks Online Accounting --
// different company (originally TSheets, acquired by Intuit), different
// base URL, different OAuth server, different credentials. Nothing here
// shares infrastructure with lib/qbo.js on purpose.
//
// Auth model: this now supports the full interactive OAuth authorization-
// code flow (api/auth/qbtime/connect.js + callback.js), which is the
// preferred path -- it returns a genuine refresh_token, so tokens renew
// themselves automatically exactly like QBO's do, no manual maintenance.
//
// The account-level "API Add-On" settings page also offers a quick-token
// shortcut (used for the very first setup) that does NOT include a
// refresh_token and instead carries a fixed, manually-extended expiration
// date -- tokens obtained that way are used as-is until they 401, at which
// point reconnecting via the real OAuth flow in Settings is the fix.

const BASE_URL = 'https://rest.tsheets.com/api/v1';

export class QbTimeAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QbTimeAuthError';
  }
}

export function getQbTimeAuthorizationUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  return `${BASE_URL}/authorize?${params.toString()}`;
}

export async function exchangeQbTimeCodeForTokens({ code, redirectUri, clientId, clientSecret }) {
  const res = await fetch(`${BASE_URL}/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`QuickBooks Time token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    obtained_at: Date.now(),
  };
}

/**
 * Exchanges a refresh_token for a fresh access_token/refresh_token pair.
 * QuickBooks Time issues a new refresh_token on every refresh (the old one
 * is invalidated), so the caller must persist the full new pair.
 */
export async function refreshQbTimeTokens({ refresh_token }, clientId, clientSecret) {
  const res = await fetch(`${BASE_URL}/grant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 400) {
      throw new QbTimeAuthError(`QuickBooks Time refresh failed (${res.status}): ${text}`);
    }
    throw new Error(`QuickBooks Time refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    obtained_at: Date.now(),
  };
}

/**
 * Proactively refreshes if the stored token has a refresh_token AND is
 * within 10 minutes of its known expiry. Tokens seeded via the manual
 * "Add Token" shortcut have no refresh_token and no reliable expires_in,
 * so they're passed through untouched -- they rely on a 401 to signal
 * that reconnecting via Settings is needed.
 */
export async function ensureFreshQbTimeTokens(tokens, clientId, clientSecret) {
  if (!tokens.refresh_token) {
    return { tokens, refreshed: false };
  }

  const obtainedAt = tokens.obtained_at || 0;
  const expiresInMs = (tokens.expires_in || 0) * 1000;
  const expiresAt = obtainedAt + expiresInMs;
  const needsRefresh = !obtainedAt || Date.now() > expiresAt - 10 * 60 * 1000;

  if (!needsRefresh) {
    return { tokens, refreshed: false };
  }

  const fresh = await refreshQbTimeTokens(tokens, clientId, clientSecret);
  return { tokens: fresh, refreshed: true };
}

async function qbTimeApiGet(path, tokens) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (res.status === 401) {
    const text = await res.text().catch(() => '');
    throw new QbTimeAuthError(`QuickBooks Time API unauthorized (token likely expired): ${text}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`QuickBooks Time API error (${res.status}): ${text}`);
  }

  return res.json();
}

/**
 * Sums timesheet duration (seconds) per user for a date range, returning
 * hours per person plus their display name. Paginates through the full
 * result set (QuickBooks Time caps each page at 200 results) rather than
 * assuming a single page covers a whole month for an active team.
 *
 * Dedupes by normalized display name, not just by QuickBooks Time's
 * internal user_id -- a person with two user records in the account
 * (e.g. an old/legacy login alongside a current one) would otherwise show
 * up as two separate rows with their hours split between them, which is
 * exactly the "two Omar Reyes" bug this fixes. Hours from any user_ids
 * sharing the same name are merged into a single entry.
 */
export async function fetchHoursByUser(tokens, { startDate, endDate }) {
  const totalsByUserId = new Map();
  const namesByUserId = new Map();

  let page = 1;
  let more = true;

  while (more) {
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      page: String(page),
      limit: '200',
    });
    const data = await qbTimeApiGet(`/timesheets?${params.toString()}`, tokens);

    const timesheets = data?.results?.timesheets || {};
    for (const ts of Object.values(timesheets)) {
      const userId = ts.user_id;
      const durationSeconds = ts.duration || 0;
      totalsByUserId.set(userId, (totalsByUserId.get(userId) || 0) + durationSeconds);
    }

    const users = data?.supplemental_data?.users || {};
    for (const [id, user] of Object.entries(users)) {
      const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || `User ${id}`;
      namesByUserId.set(Number(id), name);
    }

    more = Boolean(data?.more);
    page += 1;
    if (page > 50) break; // sanity cap -- 10,000 timesheet rows is far beyond this team's volume
  }

  const secondsByName = new Map();
  for (const [userId, seconds] of totalsByUserId.entries()) {
    const rawName = namesByUserId.get(userId) || `User ${userId}`;
    const key = rawName.trim().toLowerCase();
    const existing = secondsByName.get(key);
    if (existing) {
      existing.seconds += seconds;
    } else {
      secondsByName.set(key, { name: rawName.trim(), seconds });
    }
  }

  return Array.from(secondsByName.values())
    .map(({ name, seconds }) => ({
      name,
      hours: Math.round((seconds / 3600) * 100) / 100,
    }))
    .sort((a, b) => b.hours - a.hours);
}

/**
 * Counts active users on the QuickBooks Time account -- the real,
 * live-sourced replacement for the hardcoded TEAM_SIZE constant that used
 * to live in api/quickbooks/team.js.
 */
export async function fetchActiveUserCount(tokens) {
  let page = 1;
  let more = true;
  let count = 0;

  while (more) {
    const params = new URLSearchParams({ active: 'yes', page: String(page), limit: '200' });
    const data = await qbTimeApiGet(`/users?${params.toString()}`, tokens);
    const users = data?.results?.users || {};
    count += Object.keys(users).length;
    more = Boolean(data?.more);
    page += 1;
    if (page > 10) break; // sanity cap
  }

  return count;
}
