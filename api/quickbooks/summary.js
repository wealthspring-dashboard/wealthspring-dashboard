import { getQboTokens, setQboTokens, clearQboTokens } from '../../lib/kv.js';
import { ensureFreshTokens, fetchProfitAndLossSummary, fetchCashBalance, getPreviousPeriodParams, QboAuthError } from '../../lib/qbo.js';

export const config = { runtime: 'edge' };

const VALID_TYPES = new Set(['month', 'quarter', 'year', 'custom']);
const CURRENT_YEAR = new Date().getFullYear();

function isValidDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function parseRequestedPeriod(url) {
  const type = url.searchParams.get('type');
  const yearParam = parseInt(url.searchParams.get('year'), 10);
  const monthParam = parseInt(url.searchParams.get('month'), 10);
  const quarterParam = parseInt(url.searchParams.get('quarter'), 10);
  const fromParam = url.searchParams.get('from');
  const toParam = url.searchParams.get('to');

  const resolvedType = VALID_TYPES.has(type) ? type : 'month';

  // Custom range -- fiscal years vary by company, so this bypasses the
  // year/month/quarter validation below entirely. Falls back to "this
  // month" if the dates are missing/malformed rather than crashing.
  if (resolvedType === 'custom') {
    if (isValidDateStr(fromParam) && isValidDateStr(toParam) && fromParam <= toParam) {
      return { type: 'custom', fromDate: fromParam, toDate: toParam };
    }
    return { type: 'month', year: CURRENT_YEAR, month: new Date().getMonth() + 1, quarter: Math.floor(new Date().getMonth() / 3) + 1 };
  }

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

    // The prior-period fetch (for "biggest mover") doubles the number of
    // P&L report calls this endpoint makes -- only worth it for Cost
    // Insights, which actually shows that callout. Overview calls this
    // same endpoint far more often and doesn't need it, so it stays opt-in
    // via a flag rather than running on every request.
    const includeMover = url.searchParams.get('includeMover') === '1';

    const [pnl, cash, previousPnl] = await Promise.all([
      fetchProfitAndLossSummary(freshTokens, requestedPeriod),
      fetchCashBalance(freshTokens),
      includeMover
        ? fetchProfitAndLossSummary(freshTokens, getPreviousPeriodParams(requestedPeriod)).catch(() => null)
        : Promise.resolve(null),
    ]);

    // Biggest mover: the expense category with the largest absolute dollar
    // change vs. the immediately preceding period (not last year -- last
    // period, same type/length). Matched by name, since a category can
    // appear in one period and not the other (e.g. a one-off "Repair &
    // Maintenance" charge) -- those still count, compared against zero.
    let biggestMover = null;
    if (previousPnl && Array.isArray(pnl.expenseCategories)) {
      const previousByName = new Map(
        (previousPnl.expenseCategories || []).map((c) => [c.name, c.amount])
      );
      let best = null;
      for (const c of pnl.expenseCategories) {
        const previousAmount = previousByName.get(c.name) ?? 0;
        const change = c.amount - previousAmount;
        if (!best || Math.abs(change) > Math.abs(best.change)) {
          best = { name: c.name, currentAmount: c.amount, previousAmount, change };
        }
        previousByName.delete(c.name);
      }
      // Categories present last period but gone entirely this period also
      // count as a real (negative) move, not just categories that grew.
      for (const [name, previousAmount] of previousByName.entries()) {
        const change = 0 - previousAmount;
        if (!best || Math.abs(change) > Math.abs(best.change)) {
          best = { name, currentAmount: 0, previousAmount, change };
        }
      }
      if (best) {
        biggestMover = {
          ...best,
          changePercent: best.previousAmount !== 0
            ? Math.round((best.change / best.previousAmount) * 1000) / 10
            : null,
        };
      }
    }

    return new Response(
      JSON.stringify({
        connected: true,
        asOf: new Date().toISOString(),
        companyName: freshTokens.company_name || null,
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
        totalOperatingExpenses: pnl.totalOperatingExpenses,
        operatingExpenseRatio: pnl.operatingExpenseRatio,
        expenseCategories: pnl.expenseCategories,
        biggestMover,
        cashBalance: cash.total,
        cashBreakdown: cash.breakdown,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('QuickBooks summary fetch failed:', e.message);

    if (e instanceof QboAuthError) {
      // Refresh token is dead -- no amount of retrying fixes this. Clear it
      // so we don't keep trying with a token QuickBooks has already
      // rejected, and tell the frontend to prompt a real reconnect.
      await clearQboTokens();
      return new Response(
        JSON.stringify({ connected: false, error: 'reauth_required' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // QuickBooks connected but a live call failed for some other reason
    // (Intuit outage, report parsing edge case, etc.) -- report this
    // distinctly from "never connected" so the frontend can show a real
    // error instead of silently falling back to demo data forever.
    return new Response(
      JSON.stringify({ connected: true, error: 'fetch_failed', detail: e.message }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
