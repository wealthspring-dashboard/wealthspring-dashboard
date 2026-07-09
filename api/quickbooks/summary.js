import { getQboTokens, setQboTokens } from '../../lib/kv.js';
import { ensureFreshTokens, fetchProfitAndLossSummary, fetchCashBalance } from '../../lib/qbo.js';

export const config = { runtime: 'edge' };

const VALID_TYPES = new Set(['month', 'quarter', 'year']);
const CURRENT_YEAR = new Date().getFullYear();

function parseRequestedPeriod(url) {
  const type = url.searchParams.get('type');
  const yearParam = parseInt(url.searchParams.get('year'), 10);
  const monthParam = parseInt(url.searchParams.get('month'), 10);
  const quarterParam = parseInt(url.searchParams.get('quarter'), 10);

  const resolvedType = VALID_TYPES.has(type) ? type : 'month';

  // Sanity-bound everything server-side too, not just in the UI -- a
  // malformed or malicious query string should degrade to "this month",
  // never crash or query something nonsensical.
  const year =
    Number.isInteger(yearParam) && yearParam >= 2015 && yearParam <= CURRENT_YEAR
      ? yearParam
      : CURRENT_YEAR;

  const now = new Date();
  const month =
    resolvedType === 'month' && Number.isInteger(monthParam) && monthParam >= 1 && monthParam <= 12
      ? monthParam
      : now.getMonth() + 1;

  const quarter =
    resolvedType === 'quarter' && Number.isInteger(quarterParam) && quarterParam >= 1 && quarterParam <= 4
      ? quarterParam
      : Math.floor(now.getMonth() / 3) + 1;

  return { type: resolvedType, year, month, quarter };
}

export default async function handler(request) {
  const url = new URL(request.url);
  const requestedPeriod = parseRequestedPeriod(url);

  const tokens = await getQboTokens();

  if (!tokens) {
    return new Response(JSON.stringify({ connected: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return new Response(JSON.stringify({ connected: false, error: 'server_not_configured' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { tokens: freshTokens, refreshed } = await ensureFreshTokens(tokens, clientId, clientSecret);
    if (refreshed) {
      await setQboTokens(freshTokens);
    }

    const [pnl, cashBalance] = await Promise.all([
      fetchProfitAndLossSummary(freshTokens, requestedPeriod),
      fetchCashBalance(freshTokens),
    ]);

    return new Response(
      JSON.stringify({
        connected: true,
        asOf: new Date().toISOString(),
        type: requestedPeriod.type,
        year: requestedPeriod.year,
        month: requestedPeriod.type === 'month' ? requestedPeriod.month : undefined,
        quarter: requestedPeriod.type === 'quarter' ? requestedPeriod.quarter : undefined,
        isCurrentPeriod: pnl.isCurrentPeriod,
        periodStart: pnl.startDate,
        periodEnd: pnl.endDate,
        periodRevenue: pnl.totalRevenue,
        netIncome: pnl.netIncome,
        netProfitMargin: pnl.netProfitMargin,
        cashBalance,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    // QuickBooks connected but a live call failed (expired refresh token,
    // Intuit outage, etc.) -- report this distinctly from "never connected"
    // so the frontend can show a "reconnect needed" message instead of
    // silently falling back to demo data forever.
    return new Response(
      JSON.stringify({ connected: true, error: 'fetch_failed', detail: e.message }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
