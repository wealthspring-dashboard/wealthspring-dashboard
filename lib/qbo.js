// QuickBooks Online OAuth 2.0 + report-fetching helpers.
//
// Docs referenced:
//   OAuth:   https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
//   Reports: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/reports

const AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function apiBase() {
  return process.env.QBO_ENVIRONMENT === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

export function getAuthorizationUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

async function tokenRequest(bodyParams, clientId, clientSecret) {
  const basicAuth = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(bodyParams).toString(),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || !json) {
    const detail = json ? JSON.stringify(json) : `HTTP ${res.status}`;
    throw new Error(`QuickBooks token request failed: ${detail}`);
  }
  return json;
}

/**
 * Exchanges an OAuth authorization code for access/refresh tokens.
 */
export async function exchangeCodeForTokens({ code, redirectUri, clientId, clientSecret, realmId }) {
  const json = await tokenRequest(
    { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
    clientId,
    clientSecret
  );
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in - 60) * 1000, // refresh 60s early
    realm_id: realmId,
  };
}

/**
 * Refreshes an access token using the stored refresh token.
 */
export async function refreshTokens({ refresh_token, realm_id }, clientId, clientSecret) {
  const json = await tokenRequest(
    { grant_type: 'refresh_token', refresh_token },
    clientId,
    clientSecret
  );
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || refresh_token,
    expires_at: Date.now() + (json.expires_in - 60) * 1000,
    realm_id,
  };
}

/**
 * Returns tokens guaranteed to have a non-expired access_token,
 * refreshing against Intuit first if necessary. Returns
 * { tokens, refreshed } so the caller knows whether to persist an update.
 */
export async function ensureFreshTokens(tokens, clientId, clientSecret) {
  if (tokens.expires_at && Date.now() < tokens.expires_at) {
    return { tokens, refreshed: false };
  }
  const refreshed = await refreshTokens(tokens, clientId, clientSecret);
  return { tokens: refreshed, refreshed: true };
}

function isThrottleResponse(res, json) {
  if (res.status === 429) return true;
  // Intuit sometimes returns throttling as a 200-wrapped fault rather than
  // a real 429 -- errorCode 003001 is their documented throttle code.
  const faultError = json?.fault?.error?.[0];
  return faultError?.code === '003001';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function qboApiGet(path, tokens, attempt = 1) {
  const url = `${apiBase()}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json',
    },
  });
  const json = await res.json().catch(() => null);

  if (json && isThrottleResponse(res, json) && attempt <= 3) {
    // Intuit's documented throttle window is short-lived -- back off and
    // retry rather than surfacing a hard failure for something transient.
    await sleep(attempt * 1500);
    return qboApiGet(path, tokens, attempt + 1);
  }

  if (!res.ok || !json) {
    const detail = json ? JSON.stringify(json) : `HTTP ${res.status}`;
    throw new Error(`QuickBooks API request failed (${path}): ${detail}`);
  }
  return json;
}

/**
 * Runs `fn` over `items` with at most `limit` requests in flight at once,
 * rather than firing everything with Promise.all. QuickBooks' API throttles
 * bursts of concurrent requests (errorCode 003001) well below what a
 * multi-period report like the ratios trend needs, so this is required, not
 * just a nicety, for anything fetching more than a couple of periods.
 */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Recursively searches a QBO report's Row tree for a Summary row whose
 * first ColData label matches `labelPattern`, returning the numeric value
 * of its second column. QBO's report JSON nests rows arbitrarily deep
 * (sections within sections), so this walks the whole tree defensively
 * rather than assuming a fixed shape.
 */
function findReportSummaryValue(node, labelPattern) {
  if (!node || typeof node !== 'object') return null;

  if (node.Summary && Array.isArray(node.Summary.ColData)) {
    const label = node.Summary.ColData[0]?.value || '';
    if (labelPattern.test(label)) {
      const raw = node.Summary.ColData[1]?.value;
      const num = parseFloat(raw);
      if (!isNaN(num)) return num;
    }
  }

  const rows = node.Rows?.Row || node.Row;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const found = findReportSummaryValue(row, labelPattern);
      if (found !== null) return found;
    }
  }

  return null;
}

/**
 * Same tree walk as findReportSummaryValue, but matches by exact
 * (trimmed, case-insensitive) label against a list of acceptable strings
 * rather than a regex. Used for Balance Sheet lines where a loose pattern
 * risks false positives -- e.g. a regex for "total liabilities" would also
 * match the grand-total row "Total Liabilities and Equity", which is a
 * different, much larger number.
 */
function findReportSummaryValueByLabels(node, exactLabelsLowercase) {
  if (!node || typeof node !== 'object') return null;

  if (node.Summary && Array.isArray(node.Summary.ColData)) {
    const label = (node.Summary.ColData[0]?.value || '').trim().toLowerCase();
    if (exactLabelsLowercase.includes(label)) {
      const raw = node.Summary.ColData[1]?.value;
      const num = parseFloat(raw);
      if (!isNaN(num)) return num;
    }
  }

  const rows = node.Rows?.Row || node.Row;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const found = findReportSummaryValueByLabels(row, exactLabelsLowercase);
      if (found !== null) return found;
    }
  }

  return null;
}

/**
 * Fetches a Profit & Loss summary for an explicitly chosen period.
 * NOTE: QBO's exact report JSON labels can vary slightly by company/locale
 * settings. This searches by pattern rather than a fixed path, but should
 * be spot-checked against a real report once QuickBooks is connected.
 *
 * @param {'month'|'quarter'|'year'} type
 * @param {number} year - four-digit year
 * @param {number} [month] - 1-12, required when type === 'month'
 * @param {number} [quarter] - 1-4, required when type === 'quarter'
 */
function lastDayOfMonth(year, month /* 1-12 */) {
  // Day 0 of the *next* month is the last day of *this* month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function getDateRangeFor({ type, year, month, quarter }) {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const isCurrentYear = year === now.getFullYear();

  let startMonth, endMonth; // 1-indexed, inclusive

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

  // Full calendar end of the period, unless that would be in the future --
  // in which case cap at today, since QuickBooks has no data past "now".
  const fullEndDate = `${year}-${pad(endMonth)}-${pad(lastDayOfMonth(year, endMonth))}`;
  const isCurrentPeriod =
    isCurrentYear &&
    now.getMonth() + 1 >= startMonth &&
    now.getMonth() + 1 <= endMonth;
  const endDate = isCurrentPeriod && fullEndDate > todayStr ? todayStr : fullEndDate;

  return { startDate, endDate, isCurrentPeriod };
}

export async function fetchProfitAndLossSummary(tokens, { type = 'month', year, month, quarter } = {}) {
  const resolvedYear = year || new Date().getFullYear();
  const { startDate, endDate, isCurrentPeriod } = getDateRangeFor({ type, year: resolvedYear, month, quarter });

  const report = await qboApiGet(
    `/v3/company/${tokens.realm_id}/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&minorversion=65`,
    tokens
  );

  const totalRevenue = findReportSummaryValue(report, /total\s*income/i);
  const grossProfit = findReportSummaryValueByLabels(report, ['gross profit']);
  const operatingIncome = findReportSummaryValueByLabels(report, ['net operating income']);
  const netIncome = findReportSummaryValue(report, /net\s*income/i);

  const netProfitMargin =
    totalRevenue && netIncome !== null && totalRevenue !== 0
      ? Math.round((netIncome / totalRevenue) * 1000) / 10
      : null;

  return {
    totalRevenue,
    grossProfit,
    operatingIncome,
    netIncome,
    netProfitMargin,
    startDate,
    endDate,
    isCurrentPeriod,
  };
}

/**
 * Fetches a Balance Sheet as of a specific date (a snapshot, not a range --
 * assets/liabilities/equity are "as of a moment," unlike P&L which totals
 * a period). Known label variants are included for Total Equity since that
 * line's name varies by entity type (LLC vs corp).
 */
export async function fetchBalanceSheetSummary(tokens, asOfDate) {
  // Undocumented Intuit API behavior (confirmed independently, not just
  // theorized): the BalanceSheet report silently ignores end_date when it's
  // the only date parameter sent, and always returns the current balance
  // regardless of what date was requested. Sending a fixed, safely-early
  // start_date alongside it forces QuickBooks to actually respect end_date.
  // The start_date value itself doesn't affect the result (Balance Sheet is
  // cumulative from company inception either way) -- it just has to be present.
  const ANCHOR_START_DATE = '2015-01-01';

  const report = await qboApiGet(
    `/v3/company/${tokens.realm_id}/reports/BalanceSheet?start_date=${ANCHOR_START_DATE}&end_date=${asOfDate}&minorversion=65`,
    tokens
  );

  return {
    asOfDate,
    totalCurrentAssets: findReportSummaryValueByLabels(report, ['total current assets']),
    totalCurrentLiabilities: findReportSummaryValueByLabels(report, ['total current liabilities']),
    totalLiabilities: findReportSummaryValueByLabels(report, ['total liabilities']),
    totalEquity: findReportSummaryValueByLabels(report, [
      'total equity',
      "total stockholders' equity",
      'total stockholders equity',
      "total shareholders' equity",
      'total shareholders equity',
      "total member's equity",
      "total members' equity",
      'total members equity',
    ]),
    totalAssets: findReportSummaryValueByLabels(report, ['total assets']),
  };
}

/**
 * Fetches Net Cash from Operating Activities for a date range, used for
 * Operating Cash Flow Margin.
 */
export async function fetchCashFlowSummary(tokens, { startDate, endDate }) {
  const report = await qboApiGet(
    `/v3/company/${tokens.realm_id}/reports/CashFlow?start_date=${startDate}&end_date=${endDate}&minorversion=65`,
    tokens
  );

  return {
    netCashFromOperations: findReportSummaryValue(
      report,
      /net\s*cash\s*(provided\s*by|used\s*in|from)?\s*operating/i
    ),
  };
}

/**
 * Sums the current balance of all Bank-type accounts.
 */
export async function fetchCashBalance(tokens) {
  const query = encodeURIComponent("SELECT * FROM Account WHERE AccountType = 'Bank'");
  const result = await qboApiGet(
    `/v3/company/${tokens.realm_id}/query?query=${query}&minorversion=65`,
    tokens
  );
  const accounts = result?.QueryResponse?.Account || [];
  const total = accounts.reduce((sum, acct) => sum + (acct.CurrentBalance || 0), 0);
  return Math.round(total * 100) / 100;
}
