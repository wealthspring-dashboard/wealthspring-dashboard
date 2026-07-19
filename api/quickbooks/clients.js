import { getQboTokens, setQboTokens, clearQboTokens } from '../../lib/kv.js';
import {
  ensureFreshTokens,
  fetchCustomerSales,
  fetchAgedReceivables,
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
    // Same calendar window, one year earlier -- used only to compute
    // retention (were last year's customers still active this period).
    const prior = getDateRangeFor({ type, year: year - 1, month, quarter });

    const [currentSales, priorSales, agedReceivables] = await Promise.all([
      fetchCustomerSales(freshTokens, current),
      fetchCustomerSales(freshTokens, prior),
      fetchAgedReceivables(freshTokens),
    ]);

    const totalRevenue = currentSales.reduce((sum, c) => sum + c.amount, 0);
    const activeClientCount = currentSales.length;
    const avgRevenuePerClient = activeClientCount > 0 ? totalRevenue / activeClientCount : null;

    const top3Total = currentSales.slice(0, 3).reduce((sum, c) => sum + c.amount, 0);
    const topClientConcentration = totalRevenue > 0 ? Math.round((top3Total / totalRevenue) * 1000) / 10 : null;

    let retentionRate = null;
    let recurringRevenue = null;
    if (priorSales.length > 0) {
      const priorNames = new Set(priorSales.map((c) => c.name.toLowerCase()));
      const currentNames = new Set(currentSales.map((c) => c.name.toLowerCase()));
      const retained = priorSales.filter((c) => currentNames.has(c.name.toLowerCase())).length;
      retentionRate = Math.round((retained / priorSales.length) * 1000) / 10;

      // Proxy for "recurring revenue": this period's billings from clients
      // who were also billed in the same period last year. QuickBooks has
      // no concept of a subscription/recurring line item to read directly,
      // so "still paying a year later" is the most defensible stand-in --
      // real revenue, just filtered down to clients showing a repeat
      // pattern rather than a one-off engagement.
      recurringRevenue = currentSales
        .filter((c) => priorNames.has(c.name.toLowerCase()))
        .reduce((sum, c) => sum + c.amount, 0);
    }

    // At-risk: real outstanding balances over $0, flagged distinctly if the
    // client also isn't showing up in this period's active sales (i.e. they
    // owe money AND haven't had new billable activity recently).
    const atRiskClientCount = agedReceivables.length;
    const atRiskClients = agedReceivables.slice(0, 10).map((c) => ({
      name: c.name,
      amountOwed: c.amount,
      hasRecentActivity: currentSales.some((s) => s.name.toLowerCase() === c.name.toLowerCase()),
    }));

    return json({
      connected: true,
      asOf: new Date().toISOString(),
      periodStart: current.startDate,
      periodEnd: current.endDate,
      activeClientCount,
      avgRevenuePerClient,
      topClientConcentration,
      retentionRate,
      recurringRevenue,
      atRiskClientCount,
      atRiskClients,
      topClients: currentSales.slice(0, 5),
      // Full (untruncated) list -- used by Team & Operations to attribute
      // revenue to whoever logged hours against each client in QuickBooks
      // Time. topClients above stays capped at 5 for display purposes.
      allClientRevenue: currentSales,
    });
  } catch (e) {
    console.error('QuickBooks client intelligence fetch failed:', e.message);
    if (e instanceof QboAuthError) {
      await clearQboTokens();
      return json({ connected: false, error: 'reauth_required' });
    }
    return json({ connected: true, error: 'fetch_failed', detail: e.message });
  }
}
