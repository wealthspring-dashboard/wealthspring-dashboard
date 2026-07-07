import { getQboTokens, setQboTokens } from '../../lib/kv.js';
import { ensureFreshTokens, fetchProfitAndLossSummary, fetchCashBalance } from '../../lib/qbo.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
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
      fetchProfitAndLossSummary(freshTokens),
      fetchCashBalance(freshTokens),
    ]);

    return new Response(
      JSON.stringify({
        connected: true,
        asOf: new Date().toISOString(),
        monthlyRevenue: pnl.totalRevenue,
        netIncome: pnl.netIncome,
        netProfitMargin: pnl.netProfitMargin,
        cashBalance,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ connected: true, error: 'fetch_failed', detail: e.message }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
