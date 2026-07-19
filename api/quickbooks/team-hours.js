import { getQbTimeTokens, setQbTimeTokens, clearQbTimeTokens } from '../../lib/kv.js';
import { ensureFreshQbTimeTokens, fetchHoursByUser, fetchActiveUserCount, QbTimeAuthError } from '../../lib/qbotime.js';

export const config = { runtime: 'edge' };

const VALID_TYPES = new Set(['month', 'quarter', 'year']);

function pad(n) {
  return String(n).padStart(2, '0');
}

function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Same date-range logic used elsewhere: full period, capped at today if current. */
function getDateRangeFor({ type, year, month, quarter }) {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  let startMonth, endMonth;

  if (type === 'month') {
    startMonth = month;
    endMonth = month;
  } else if (type === 'quarter') {
    startMonth = (quarter - 1) * 3 + 1;
    endMonth = startMonth + 2;
  } else {
    startMonth = 1;
    endMonth = 12;
  }

  const startDate = `${year}-${pad(startMonth)}-01`;
  const fullEndDate = `${year}-${pad(endMonth)}-${pad(lastDayOfMonth(year, endMonth))}`;
  const endDate = fullEndDate > todayStr ? todayStr : fullEndDate;

  return { startDate, endDate };
}

function parseRequest(url) {
  const now = new Date();
  const type = VALID_TYPES.has(url.searchParams.get('type')) ? url.searchParams.get('type') : 'month';
  const year = parseInt(url.searchParams.get('year'), 10) || now.getFullYear();
  const month = parseInt(url.searchParams.get('month'), 10) || now.getMonth() + 1;
  const quarter = parseInt(url.searchParams.get('quarter'), 10) || Math.floor(now.getMonth() / 3) + 1;
  return { type, year, month, quarter };
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(request) {
  const url = new URL(request.url);
  const { type, year, month, quarter } = parseRequest(url);

  const tokens = await getQbTimeTokens();
  if (!tokens) return json({ connected: false });

  const clientId = process.env.QBTIME_CLIENT_ID;
  const clientSecret = process.env.QBTIME_CLIENT_SECRET;

  try {
    const { tokens: freshTokens, refreshed } = await ensureFreshQbTimeTokens(tokens, clientId, clientSecret);
    if (refreshed) await setQbTimeTokens(freshTokens);

    const current = getDateRangeFor({ type, year, month, quarter });
    const [hoursByUser, teamSize] = await Promise.all([
      fetchHoursByUser(freshTokens, current),
      fetchActiveUserCount(freshTokens).catch(() => null),
    ]);

    const totalHours = hoursByUser.reduce((sum, u) => sum + u.hours, 0);

    return json({
      connected: true,
      asOf: new Date().toISOString(),
      periodStart: current.startDate,
      periodEnd: current.endDate,
      totalHours: Math.round(totalHours * 100) / 100,
      teamSize,
      hoursByUser,
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
