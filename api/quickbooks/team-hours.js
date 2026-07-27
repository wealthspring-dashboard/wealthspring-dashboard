import { getQbTimeTokens, setQbTimeTokens, clearQbTimeTokens } from '../../lib/kv.js';
import { ensureFreshQbTimeTokens, fetchHoursByUser, QbTimeAuthError } from '../../lib/qbotime.js';
import { getDateRangeFor } from '../../lib/qbo.js';

export const config = { runtime: 'edge' };

const VALID_TYPES = new Set(['month', 'quarter', 'year', 'custom']);

function isValidDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function parseRequest(url) {
  const now = new Date();
  const type = VALID_TYPES.has(url.searchParams.get('type')) ? url.searchParams.get('type') : 'month';
  const year = parseInt(url.searchParams.get('year'), 10) || now.getFullYear();
  const month = parseInt(url.searchParams.get('month'), 10) || now.getMonth() + 1;
  const quarter = parseInt(url.searchParams.get('quarter'), 10) || Math.floor(now.getMonth() / 3) + 1;
  const fromParam = url.searchParams.get('from');
  const toParam = url.searchParams.get('to');
  const fromDate = isValidDateStr(fromParam) ? fromParam : null;
  const toDate = isValidDateStr(toParam) ? toParam : null;
  return { type, year, month, quarter, fromDate, toDate };
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(request) {
  const url = new URL(request.url);
  const { type, year, month, quarter, fromDate, toDate } = parseRequest(url);

  const tokens = await getQbTimeTokens();
  if (!tokens) return json({ connected: false });

  const clientId = process.env.QBTIME_CLIENT_ID;
  const clientSecret = process.env.QBTIME_CLIENT_SECRET;

  try {
    const { tokens: freshTokens, refreshed } = await ensureFreshQbTimeTokens(tokens, clientId, clientSecret);
    if (refreshed) await setQbTimeTokens(freshTokens);

    const current = getDateRangeFor({ type, year, month, quarter, fromDate, toDate });
    const { hoursByUser, hoursByUserAndClient } = await fetchHoursByUser(freshTokens, current);

    const totalHours = hoursByUser.reduce((sum, u) => sum + u.hours, 0);

    // Team Size = number of distinct people who actually logged hours this
    // period, i.e. exactly the rows shown in the roster table below it.
    // Deliberately NOT "everyone marked active in QuickBooks Time" -- that
    // count included stale/legacy seats nobody had gotten around to
    // deactivating, which is why it was showing 17 against a roster of a
    // handful of real people.
    const teamSize = hoursByUser.length;

    return json({
      connected: true,
      asOf: new Date().toISOString(),
      periodStart: current.startDate,
      periodEnd: current.endDate,
      totalHours: Math.round(totalHours * 100) / 100,
      teamSize,
      hoursByUser,
      hoursByUserAndClient,
    });
  } catch (e) {
    console.error('QuickBooks Time hours fetch failed:', e.message);
    if (e instanceof QbTimeAuthError) {
      await clearQbTimeTokens();
      return json({ connected: false, error: 'reauth_required' });
    }
    return json({ connected: true, error: 'fetch_failed', detail: e.message });
  }
}
