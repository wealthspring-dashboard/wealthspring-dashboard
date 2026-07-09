import { getQboTokens, setQboTokens } from '../../lib/kv.js';
import { ensureFreshTokens, fetchProfitAndLossSummary, fetchCashBalance } from '../../lib/qbo.js';

export const config = { runtime: 'edge' };

const VALID_PERIODS = new Set(['month', 'quarter', 'year']);

export default async function handler(request) {
  const url = new URL(request.url);
  const requestedPeriod = url.searchParams.get('period');
  const period = VALID_PERIODS.has(requestedPeriod) ? requestedPeriod : 'month';

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
      fetchProfitAndLossSummary(freshTokens, period),
      fetchCashBalance(freshTokens),
    ]);

    return new Response(
      JSON.stringify({
        connected: true,
        asOf: new Date().toISOString(),
        period,
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
