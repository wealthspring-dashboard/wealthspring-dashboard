import { mapWithConcurrency } from './qbo.js';

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
 * Sums timesheet duration (seconds) per user for a date range in a single
 * pass, returning both a simple per-person total (for the roster hours
 * column) and a per-person-per-client breakdown (for revenue attribution
 * -- see loadTeamOperations in index.html). Paginates through the full
 * result set (QuickBooks Time caps each page at 200 results) rather than
 * assuming a single page covers a whole month for an active team.
 *
 * Dedupes people by normalized display name, not just by QuickBooks
 * Time's internal user_id -- a person with two user records in the
 * account (e.g. an old/legacy login alongside a current one) would
 * otherwise show up as two separate rows with their hours split between
 * them, which is exactly the "two Omar Reyes" bug this fixes.
 *
 * Client attribution relies on each timesheet's jobcode -- when
 * QuickBooks Time is synced to QuickBooks Online, jobcodes correspond to
 * QBO customers, so a jobcode name should match a customer name from
 * fetchCustomerSales (see lib/qbo.js). Timesheets with no jobcode (or an
 * unbillable/internal one) are counted in the per-person total but
 * excluded from the per-client breakdown.
 */
/**
 * Splits [startDate, endDate] into consecutive windows no longer than
 * maxDays each. QuickBooks Time hard-rejects a single request spanning
 * too broad a range (confirmed in production: "Your date range was too
 * long, please narrow and try again!" -- a real validation error, not a
 * timeout), so a full year has to go through as several smaller requests
 * rather than one.
 */
function buildDateChunks(startDate, endDate, maxDays) {
  const chunks = [];
  let chunkStart = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  while (chunkStart <= end) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + maxDays - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());

    chunks.push({
      start: chunkStart.toISOString().slice(0, 10),
      end: chunkEnd.toISOString().slice(0, 10),
    });

    chunkStart = new Date(chunkEnd);
    chunkStart.setUTCDate(chunkStart.getUTCDate() + 1);
  }
  return chunks;
}

export async function fetchHoursByUser(tokens, { startDate, endDate }) {
  const totalSecondsByUserId = new Map();
  const secondsByUserAndJob = new Map(); // key: `${userId}::${jobcodeId}`
  const namesByUserId = new Map();
  const namesByJobcodeId = new Map();

  /**
   * Fetches and fully paginates one date-range chunk, writing into the
   * shared maps above. Safe to run several of these concurrently even
   * though they share those maps -- each individual Map.set() call
   * completes synchronously before any other async work runs (JS has no
   * true parallelism), and summing durations is order-independent, so
   * there's nothing for concurrent chunks to actually race on.
   */
  async function fetchChunk(chunkStart, chunkEnd) {
    let page = 1;
    let more = true;

    while (more) {
      const params = new URLSearchParams({
        start_date: chunkStart,
        end_date: chunkEnd,
        page: String(page),
        limit: '200',
      });
      const data = await qbTimeApiGet(`/timesheets?${params.toString()}`, tokens);

      const timesheets = data?.results?.timesheets || {};
      for (const ts of Object.values(timesheets)) {
        const userId = ts.user_id;
        const jobcodeId = ts.jobcode_id;
        const durationSeconds = ts.duration || 0;

        totalSecondsByUserId.set(userId, (totalSecondsByUserId.get(userId) || 0) + durationSeconds);

        if (jobcodeId) {
          const key = `${userId}::${jobcodeId}`;
          const entry = secondsByUserAndJob.get(key) || { userId, jobcodeId, seconds: 0 };
          entry.seconds += durationSeconds;
          secondsByUserAndJob.set(key, entry);
        }
      }

      const users = data?.supplemental_data?.users || {};
      for (const [id, user] of Object.entries(users)) {
        const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || `User ${id}`;
        namesByUserId.set(Number(id), name);
      }

      // Note: QuickBooks Time jobcodes carry their own "billable" flag,
      // but confirmed (via production diagnostic, not assumed) that
      // Wealthspring's account has it set to false uniformly across every
      // jobcode -- including real paying clients -- so it carries no
      // actual signal here and isn't used. Client-vs-internal is
      // determined downstream instead, by whether the jobcode name
      // matches a real QuickBooks customer (see resolveClientNames in
      // index.html) -- the best available signal given flat-fee billing
      // means there's no native "billable hour" concept to read from
      // QuickBooks Time in the first place.
      const jobcodes = data?.supplemental_data?.jobcodes || {};
      for (const [id, jobcode] of Object.entries(jobcodes)) {
        if (jobcode?.name) namesByJobcodeId.set(Number(id), jobcode.name);
      }

      more = Boolean(data?.more);
      page += 1;
      if (page > 50) break; // sanity cap -- 10,000 timesheet rows in a single chunk is far beyond this team's volume
    }
  }

  // ~31-day chunks stay safely under QuickBooks Time's undocumented range
  // limit and keep each individual request's own pagination small enough
  // to finish well within Vercel's time budget. Concurrency of 3 keeps a
  // full year (~12 chunks) to about 4 sequential waves instead of either
  // one slow chain of 12 or a burst of 12 at once against Intuit's API.
  const chunks = buildDateChunks(startDate, endDate, 31);
  await mapWithConcurrency(chunks, 3, (chunk) => fetchChunk(chunk.start, chunk.end));

  // Merge per-user totals by normalized name.
  const totalSecondsByName = new Map();
  for (const [userId, seconds] of totalSecondsByUserId.entries()) {
    const rawName = namesByUserId.get(userId) || `User ${userId}`;
    const key = rawName.trim().toLowerCase();
    const existing = totalSecondsByName.get(key);
    if (existing) {
      existing.seconds += seconds;
    } else {
      totalSecondsByName.set(key, { name: rawName.trim(), seconds });
    }
  }

  const hoursByUser = Array.from(totalSecondsByName.values())
    .map(({ name, seconds }) => ({
      name,
      hours: Math.round((seconds / 3600) * 100) / 100,
    }))
    .sort((a, b) => b.hours - a.hours);

  // Merge per-user-per-client breakdown by normalized (user name, client name).
  const secondsByNamePair = new Map();
  for (const { userId, jobcodeId, seconds } of secondsByUserAndJob.values()) {
    const userName = (namesByUserId.get(userId) || `User ${userId}`).trim();
    const clientName = (namesByJobcodeId.get(jobcodeId) || '').trim();
    if (!clientName) continue; // jobcode wasn't in supplemental_data -- skip rather than guess
    const key = `${userName.toLowerCase()}::${clientName.toLowerCase()}`;
    const existing = secondsByNamePair.get(key);
    if (existing) {
      existing.seconds += seconds;
    } else {
      secondsByNamePair.set(key, { userName, clientName, seconds });
    }
  }

  const hoursByUserAndClient = Array.from(secondsByNamePair.values())
    .map(({ userName, clientName, seconds }) => ({
      userName,
      clientName,
      hours: Math.round((seconds / 3600) * 100) / 100,
    }))
    .sort((a, b) => b.hours - a.hours);

  return { hoursByUser, hoursByUserAndClient };
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
