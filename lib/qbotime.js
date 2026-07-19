// Client for the QuickBooks Time API (formerly TSheets).
//
// This is a genuinely separate product from QuickBooks Online Accounting --
// different company (originally TSheets, acquired by Intuit), different
// base URL, different OAuth server, different credentials. Nothing here
// shares infrastructure with lib/qbo.js on purpose.
//
// Auth model: QuickBooks Time's account-level "API Add-On" settings page
// offers a shortcut -- click "Add Token" and get a ready-to-use access
// token directly, no OAuth redirect flow required. The tradeoff is that
// this shortcut token is NOT paired with a refresh_token, so it can't be
// auto-renewed the way QBO's tokens are. It has a fixed expiration date
// (extendable manually on that same settings page) instead. When it
// expires, fetchHoursByUser below will get a 401 from QuickBooks Time,
// which surfaces as QbTimeAuthError -- at that point a new token needs to
// be generated on the QuickBooks Time API Add-On page and re-seeded via
// api/auth/qbtime/seed.js. If this manual step becomes a hassle, the full
// interactive OAuth authorization-code flow (mirroring api/auth/qbo/) is
// the upgrade path to true auto-refresh -- not built here since it wasn't
// needed to get this working today.

const BASE_URL = 'https://rest.tsheets.com/api/v1';

export class QbTimeAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QbTimeAuthError';
  }
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

  return Array.from(totalsByUserId.entries())
    .map(([userId, seconds]) => ({
      userId,
      name: namesByUserId.get(userId) || `User ${userId}`,
      hours: Math.round((seconds / 3600) * 100) / 100,
    }))
    .sort((a, b) => b.hours - a.hours);
}
