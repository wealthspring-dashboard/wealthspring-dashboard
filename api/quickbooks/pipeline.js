import { getQboTokens, setQboTokens, clearQboTokens } from '../../lib/kv.js';
import {
  ensureFreshTokens,
  fetchNewCustomers,
  fetchCustomerSales,
  getDateRangeFor,
  QboAuthError,
} from '../../lib/qbo.js';

export const config = { runtime: 'edge' };

const VALID_TYPES = new Set(['month', 'quarter', 'year', 'custom']);

function shiftDateByYears(dateStr, years) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

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

    const current = getDateRangeFor({ type, year, month, quarter, fromDate, toDate });
    // Same calendar window, one year earlier -- for a YoY comparison. For a
    // custom range, that means both endpoints shifted back a year, since
    // there's no single calendar year to decrement.
    const prior = type === 'custom'
      ? getDateRangeFor({ type: 'custom', fromDate: shiftDateByYears(current.startDate, -1), toDate: shiftDateByYears(current.endDate, -1) })
      : getDateRangeFor({ type, year: year - 1, month, quarter });
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
