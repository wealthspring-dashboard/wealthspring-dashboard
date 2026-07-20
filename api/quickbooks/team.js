import { getQboTokens, setQboTokens, clearQboTokens } from '../../lib/kv.js';
import {
  ensureFreshTokens,
  fetchProfitAndLossSummary,
  fetchContractLaborSpend,
  fetchLaborRelatedAccounts,
  QboAuthError,
} from '../../lib/qbo.js';

export const config = { runtime: 'edge' };

const VALID_TYPES = new Set(['month', 'quarter', 'year']);

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseRequest(url) {
  const now = new Date();
  const type = VALID_TYPES.has(url.searchParams.get('type')) ? url.searchParams.get('type') : 'month';
  const year = parseInt(url.searchParams.get('year'), 10) || now.getFullYear();
  const month = parseInt(url.searchParams.get('month'), 10) || now.getMonth() + 1;
  const quarter = parseInt(url.searchParams.get('quarter'), 10) || Math.floor(now.getMonth() / 3) + 1;
  return { type, year, month, quarter };
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

    const pnl = await fetchProfitAndLossSummary(freshTokens, { type, year, month, quarter });
    const contractLabor = await fetchContractLaborSpend(freshTokens, {
      startDate: pnl.startDate,
      endDate: pnl.endDate,
    }).catch(() => ({ value: null, source: null }));

    // Temporary diagnostic: log every Chart of Accounts entry that looks
    // labor/contractor-related, with its current balance, so the Contract
    // Labor calculation can be refined against Wealthspring's real chart
    // of accounts instead of guessing at account names again. Safe to
    // remove once that refinement ships. Awaited (not fire-and-forget) --
    // an Edge function isn't guaranteed to finish background work after
    // the response is returned.
    try {
      const laborAccounts = await fetchLaborRelatedAccounts(freshTokens);
      console.error('Labor-related Chart of Accounts:', JSON.stringify(laborAccounts));
    } catch (e) {
      console.error('Labor-related Chart of Accounts lookup failed:', e.message);
    }

    return json({
      connected: true,
      asOf: new Date().toISOString(),
      periodStart: pnl.startDate,
      periodEnd: pnl.endDate,
      totalRevenue: pnl.totalRevenue,
      contractLaborSpend: contractLabor.value,
      contractLaborSource: contractLabor.source,
    });
  } catch (e) {
    console.error('QuickBooks team metrics fetch failed:', e.message);
    if (e instanceof QboAuthError) {
      await clearQboTokens();
      return json({ connected: false, error: 'reauth_required' });
    }
    return json({ connected: true, error: 'fetch_failed', detail: e.message });
  }
}
