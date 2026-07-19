import { getQboTokens, setQboTokens, clearQboTokens } from '../../lib/kv.js';
import {
  ensureFreshTokens,
  fetchNewCustomers,
  fetchCustomerSales,
  QboAuthError,
} from '../../lib/qbo.js';

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

  const tokens = await getQboTokens();
  if (!tokens) return json({ connected: false });

  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return json({ connected: false, error: 'server_not_configured' });
  }

  try {
    const { tokens: freshTokens, refreshed } = await ensureFreshTokens(tokens, clientId, clientSecret);
    if (refreshed) await setQboTokens(freshTokens);

    const current = getDateRangeFor({ type, year, month, quarter });
    // Same calendar window, one year earlier -- for a YoY comparison.
    const prior = getDateRangeFor({ type, year: year - 1, month, quarter });
    // Jan 1 through today -- a stable annual pulse independent of
    // whatever period the topbar selector happens to be set to.
    const ytd = getDateRangeFor({ type: 'year', year: new Date().getFullYear() });

    const [newThisPeriod, newPriorPeriod, newYtd, currentSales] = await Promise.all([
      fetchNewCustomers(freshTokens, current),
      fetchNewCustomers(freshTokens, prior),
      fetchNewCustomers(freshTokens, ytd),
      fetchCustomerSales(freshTokens, current),
    ]);

    const newClientCount = newThisPeriod.length;
    const newClientCountPriorYear = newPriorPeriod.length;
    const yoyChangePct = newClientCountPriorYear > 0
      ? Math.round(((newClientCount - newClientCountPriorYear) / newClientCountPriorYear) * 1000) / 10
      : null;

    // Revenue this period attributable to clients who were also new this
    // period (cross-referencing against the Customer Sales report already
    // used on the Client Intelligence tab).
    const newClientNames = new Set(newThisPeriod.map((c) => c.name.toLowerCase()));
    const newClientRevenue = currentSales
      .filter((s) => newClientNames.has(s.name.toLowerCase()))
      .reduce((sum, s) => sum + s.amount, 0);

    return json({
      connected: true,
      asOf: new Date().toISOString(),
      periodStart: current.startDate,
      periodEnd: current.endDate,
      newClientCount,
      newClientCountPriorYear,
      yoyChangePct,
      newClientRevenue,
      newClientsYtd: newYtd.length,
      newClients: newThisPeriod,
    });
  } catch (e) {
    console.error('QuickBooks pipeline fetch failed:', e.message);
    if (e instanceof QboAuthError) {
      await clearQboTokens();
      return json({ connected: false, error: 'reauth_required' });
    }
    return json({ connected: true, error: 'fetch_failed', detail: e.message });
  }
}
