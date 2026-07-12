import { getQboTokens, setQboTokens, clearQboTokens } from '../../lib/kv.js';
import {
  ensureFreshTokens,
  fetchProfitAndLossSummary,
  fetchBalanceSheetSummary,
  fetchCashFlowSummary,
  mapWithConcurrency,
  QboAuthError,
} from '../../lib/qbo.js';

export const config = { runtime: 'edge' };

// Intuit throttles bursts of concurrent requests per company -- this keeps
// us comfortably under that regardless of how many periods are requested.
const QBO_CONCURRENCY = 3;

const VALID_TYPES = new Set(['month', 'quarter', 'year']);
const DEFAULT_COUNT = { month: 12, quarter: 6, year: 5 };
const MAX_COUNT = 12;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function clampInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function parseRequest(url) {
  const now = new Date();
  const typeParam = url.searchParams.get('type');
  const type = VALID_TYPES.has(typeParam) ? typeParam : 'quarter';

  const year = clampInt(parseInt(url.searchParams.get('year'), 10), 2015, now.getFullYear()) || now.getFullYear();
  const month =
    clampInt(parseInt(url.searchParams.get('month'), 10), 1, 12) || now.getMonth() + 1;
  const quarter =
    clampInt(parseInt(url.searchParams.get('quarter'), 10), 1, 4) || Math.floor(now.getMonth() / 3) + 1;

  const count =
    clampInt(parseInt(url.searchParams.get('count'), 10), 1, MAX_COUNT) || DEFAULT_COUNT[type];

  return { type, year, month, quarter, count };
}

/** Steps a {year, month|quarter} period back by n periods of the same type. */
function stepPeriodBack({ type, year, month, quarter }, n) {
  if (type === 'month') {
    let m = month - n;
    let y = year;
    while (m < 1) {
      m += 12;
      y -= 1;
    }
    return { year: y, month: m, quarter: undefined };
  }
  if (type === 'quarter') {
    let q = quarter - n;
    let y = year;
    while (q < 1) {
      q += 4;
      y -= 1;
    }
    return { year: y, month: undefined, quarter: q };
  }
  return { year: year - n, month: undefined, quarter: undefined };
}

function periodLabel({ type, year, month, quarter }) {
  if (type === 'month') return `${MONTH_NAMES[month - 1]} ${year}`;
  if (type === 'quarter') return `Q${quarter} ${year}`;
  return `${year}`;
}

function ratio(numerator, denominator) {
  if (numerator === null || numerator === undefined) return null;
  if (denominator === null || denominator === undefined || denominator === 0) return null;
  return Math.round((numerator / denominator) * 10000) / 10000;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(request) {
  const url = new URL(request.url);
  const { type, year, month, quarter, count } = parseRequest(url);

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

    // Build (count + 1) consecutive periods, oldest first, ending at the
    // requested one. The extra oldest entry (index 0) exists only so the
    // first *displayed* period has something to compute revenue growth
    // against -- it is not itself returned in the response.
    const periods = [];
    for (let i = count; i >= 0; i--) {
      periods.push(stepPeriodBack({ type, year, month, quarter }, i));
    }

    // P&L needed for every period (growth rate needs the adjacent one).
    const pnlResults = await mapWithConcurrency(periods, QBO_CONCURRENCY, (p) =>
      fetchProfitAndLossSummary(freshTokens, { type, year: p.year, month: p.month, quarter: p.quarter })
    );

    // Balance Sheet / Cash Flow only needed for the periods we actually
    // display -- skip the extra prior one to save report calls. Run these
    // two phases one after the other (not simultaneously) so we never have
    // more than QBO_CONCURRENCY requests in flight against Intuit at once.
    const displayedPeriods = periods.slice(1);
    const balanceSheets = await mapWithConcurrency(displayedPeriods, QBO_CONCURRENCY, (p, i) =>
      fetchBalanceSheetSummary(freshTokens, pnlResults[i + 1].endDate)
    );
    const cashFlows = await mapWithConcurrency(displayedPeriods, QBO_CONCURRENCY, (p, i) =>
      fetchCashFlowSummary(freshTokens, { startDate: pnlResults[i + 1].startDate, endDate: pnlResults[i + 1].endDate })
    );

    const series = displayedPeriods.map((p, i) => {
      const pnl = pnlResults[i + 1];
      const priorPnl = pnlResults[i];
      const bs = balanceSheets[i];
      const cf = cashFlows[i];

      const revenueGrowthRate =
        priorPnl.totalRevenue !== null && priorPnl.totalRevenue !== 0 && pnl.totalRevenue !== null
          ? Math.round(((pnl.totalRevenue - priorPnl.totalRevenue) / priorPnl.totalRevenue) * 10000) / 10000
          : null;

      return {
        label: periodLabel({ type, year: p.year, month: p.month, quarter: p.quarter }),
        periodStart: pnl.startDate,
        periodEnd: pnl.endDate,
        revenueGrowthRate,
        grossMargin: ratio(pnl.grossProfit, pnl.totalRevenue),
        operatingMargin: ratio(pnl.operatingIncome, pnl.totalRevenue),
        netMargin: ratio(pnl.netIncome, pnl.totalRevenue),
        operatingCashFlowMargin: ratio(cf.netCashFromOperations, pnl.totalRevenue),
        currentRatio: ratio(bs.totalCurrentAssets, bs.totalCurrentLiabilities),
        debtToEquity: ratio(bs.totalLiabilities, bs.totalEquity),
        returnOnAssets: ratio(pnl.netIncome, bs.totalAssets),
        returnOnEquity: ratio(pnl.netIncome, bs.totalEquity),
      };
    });

    return json({ connected: true, type, count, series });
  } catch (e) {
    if (e instanceof QboAuthError) {
      await clearQboTokens();
      return json({ connected: false, error: 'reauth_required' });
    }
    return json({ connected: true, error: 'fetch_failed', detail: e.message });
  }
}
