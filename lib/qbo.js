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

// Thrown specifically when Intuit rejects a refresh token as invalid/expired
// (error: "invalid_grant"). This means the connection is genuinely dead --
// no amount of retrying will fix it, and the only path forward is the user
// reconnecting QuickBooks from Settings. Callers use this to distinguish
// "please reconnect" from ordinary transient failures.
export class QboAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QboAuthError';
  }
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

  // Intuit's own recommendation: capture this on every response so it can be
  // handed to their support team if we ever need to escalate an issue --
  // it's how they trace a specific request through their systems.
  const intuitTid = res.headers.get('intuit_tid');
  const json = await res.json().catch(() => null);

  if (json?.error === 'invalid_grant') {
    throw new QboAuthError(
      `QuickBooks refresh token is no longer valid: ${JSON.stringify(json)} [intuit_tid: ${intuitTid || 'none'}]`
    );
  }

  if (!res.ok || !json) {
    const detail = json ? JSON.stringify(json) : `HTTP ${res.status}`;
    throw new Error(`QuickBooks token request failed: ${detail} [intuit_tid: ${intuitTid || 'none'}]`);
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
export async function refreshTokens({ refresh_token, realm_id, company_name }, clientId, clientSecret) {
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
    company_name,
  };
}

/**
 * Fetches the connected company's display name from QuickBooks. Called once
 * at connect-time and stored alongside the tokens (see api/auth/qbo/callback.js)
 * rather than re-fetched on every request -- this is Wealthspring's own tool
 * for reviewing multiple companies' books (their own + clients'), so it's
 * important the dashboard always shows *which* company is currently connected.
 */
export async function fetchCompanyInfo(tokens) {
  const result = await qboApiGet(`/v3/company/${tokens.realm_id}/companyinfo/${tokens.realm_id}?minorversion=65`, tokens);
  return result?.CompanyInfo?.CompanyName || result?.CompanyInfo?.LegalName || null;
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

  // Intuit's own recommendation: capture this on every response so it can be
  // handed to their support team if we ever need to escalate an issue --
  // it's how they trace a specific request through their systems.
  const intuitTid = res.headers.get('intuit_tid');
  const json = await res.json().catch(() => null);

  if (json && isThrottleResponse(res, json) && attempt <= 3) {
    // Intuit's documented throttle window is short-lived -- back off and
    // retry rather than surfacing a hard failure for something transient.
    await sleep(attempt * 1500);
    return qboApiGet(path, tokens, attempt + 1);
  }

  if (!res.ok || !json) {
    const detail = json ? JSON.stringify(json) : `HTTP ${res.status}`;
    throw new Error(`QuickBooks API request failed (${path}): ${detail} [intuit_tid: ${intuitTid || 'none'}]`);
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

/**
 * @param {'month'|'quarter'|'year'|'custom'} type
 * @param {number} year - four-digit year (ignored when type === 'custom')
 * @param {number} [month] - 1-12, required when type === 'month'
 * @param {number} [quarter] - 1-4, required when type === 'quarter'
 * @param {string} [fromDate] - 'YYYY-MM-DD', required when type === 'custom'
 * @param {string} [toDate] - 'YYYY-MM-DD', required when type === 'custom'
 */
export function getDateRangeFor({ type, year, month, quarter, fromDate, toDate }) {
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  // Custom range -- fiscal years vary by company, so this bypasses the
  // calendar month/quarter/year math entirely and just uses the two dates
  // given, still capped at today (QuickBooks has no data past "now").
  // Never treated as "the current period" for vs-target comparisons --
  // those assume a specific, known calendar window (this month), which an
  // arbitrary custom range isn't.
  if (type === 'custom') {
    const startDate = fromDate;
    const endDate = toDate && toDate > todayStr ? todayStr : toDate;
    return { startDate, endDate, isCurrentPeriod: false };
  }

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

export async function fetchProfitAndLossSummary(tokens, { type = 'month', year, month, quarter, fromDate, toDate } = {}) {
  const resolvedYear = year || new Date().getFullYear();
  const { startDate, endDate, isCurrentPeriod } = getDateRangeFor({ type, year: resolvedYear, month, quarter, fromDate, toDate });

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
 * Walks a report's row tree collecting every leaf row that looks like a
 * single named entity with one amount (e.g. one customer's revenue, one
 * vendor's AR balance) -- as opposed to header/subtotal rows. Skips rows
 * whose label suggests a subtotal ("Total ...") to avoid double-counting.
 */
function collectReportEntityAmounts(node, results = []) {
  if (!node || typeof node !== 'object') return results;

  const rows = node.Rows?.Row || node.Row;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const colData = row.ColData;
      if (Array.isArray(colData) && colData.length >= 2 && colData[0]?.value) {
        const label = colData[0].value.trim();
        const raw = colData[colData.length - 1]?.value;
        const amount = parseFloat(raw);
        if (label && !/^total\b/i.test(label) && !isNaN(amount)) {
          results.push({ name: label, amount });
        }
      }
      // Recurse into sub-rows (grouped reports nest a customer's detail
      // rows under a group header) without adding the group header itself.
      collectReportEntityAmounts(row, results);
    }
  }
  return results;
}

/**
 * Revenue broken down by customer for a date range. Used for active client
 * count, revenue concentration, and retention comparisons.
 * NOTE: this is the first time this project queries QuickBooks' CustomerSales
 * report -- the exact row shape should be spot-checked against a real
 * response, same as every other report parser in this file was.
 */
export async function fetchCustomerSales(tokens, { startDate, endDate }) {
  const report = await qboApiGet(
    `/v3/company/${tokens.realm_id}/reports/CustomerSales?start_date=${startDate}&end_date=${endDate}&minorversion=65`,
    tokens
  );
  return collectReportEntityAmounts(report)
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Outstanding receivables by customer, used to flag at-risk clients
 * (customers who owe money and haven't paid) rather than a guessed "health
 * score." QuickBooks buckets this by how overdue the balance is; we surface
 * the total outstanding and treat >30 days overdue as at-risk.
 */
/**
 * QuickBooks' Aged Receivables report has one column per aging bucket
 * (Current, 1-30, 31-60, 61-90, 91+, then a Total) -- reads the real
 * column headers (rather than assuming a fixed position/count, since a
 * customized report could have different buckets) to separate "Current"
 * (billed, but not yet due -- not actually at risk) from genuinely
 * past-due amounts, and to identify which bucket each client's oldest
 * unpaid balance falls into.
 */
export async function fetchAgedReceivables(tokens) {
  const report = await qboApiGet(
    `/v3/company/${tokens.realm_id}/reports/AgedReceivables?minorversion=65`,
    tokens
  );

  const columns = report?.Columns?.Column || [];
  const colTitles = columns.map((c) => (c.ColTitle || '').trim());
  const currentIdx = colTitles.findIndex((t) => /^current$/i.test(t));
  const totalIdx = colTitles.findIndex((t) => /^total$/i.test(t));
  // Every column that isn't the name column, "Current", or "Total" is a
  // past-due aging bucket (e.g. "1 - 30", "31 - 60", "61 - 90", "91 and over").
  const bucketIndexes = colTitles
    .map((t, i) => ({ t, i }))
    .filter(({ t, i }) => i !== 0 && i !== currentIdx && i !== totalIdx && t)
    .map(({ i }) => i);

  function collectRows(node, results) {
    const rows = node.Rows?.Row || node.Row;
    if (!Array.isArray(rows)) return results;
    for (const row of rows) {
      const colData = row.ColData;
      if (Array.isArray(colData) && colData.length >= 2 && colData[0]?.value) {
        const label = colData[0].value.trim();
        if (label && !/^total\b/i.test(label)) {
          const totalOwed = totalIdx >= 0 ? parseFloat(colData[totalIdx]?.value) : NaN;
          const currentAmount = currentIdx >= 0 ? (parseFloat(colData[currentIdx]?.value) || 0) : 0;

          if (!isNaN(totalOwed) && totalOwed > 0) {
            const pastDueAmount = bucketIndexes.length > 0
              ? bucketIndexes.reduce((sum, i) => sum + (parseFloat(colData[i]?.value) || 0), 0)
              : Math.max(0, totalOwed - currentAmount);

            // Find the oldest (rightmost) bucket that actually has a balance.
            let oldestBucketLabel = null;
            for (let j = bucketIndexes.length - 1; j >= 0; j--) {
              const idx = bucketIndexes[j];
              if ((parseFloat(colData[idx]?.value) || 0) > 0) {
                oldestBucketLabel = colTitles[idx];
                break;
              }
            }

            results.push({
              name: label,
              totalOwed,
              currentAmount,
              pastDueAmount: Math.round(pastDueAmount * 100) / 100,
              oldestBucketLabel,
            });
          }
        }
      }
      collectRows(row, results);
    }
    return results;
  }

  return collectRows(report, [])
    // "At risk" means genuinely past due -- a client who owes money but is
    // still within terms (entirely in the "Current" bucket) isn't at risk,
    // they just have an open invoice.
    .filter((r) => r.pastDueAmount > 0)
    .sort((a, b) => b.pastDueAmount - a.pastDueAmount);
}

/**
 * Total spend on the Contract Labor expense account for a date range.
 * Wealthspring pays its team as independent contractors via bank transfer
 * (no QuickBooks Payroll), so this is the real, direct source for team
 * spend -- label variants included since the exact account name varies.
 * This makes its own P&L call rather than reusing fetchProfitAndLossSummary's
 * internal report, to avoid touching that already-verified function.
 */
/**
 * Same idea as findReportSummaryValueByLabels, but also matches plain
 * leaf line-item rows -- a row with its own ColData directly (no nested
 * Summary), which is the shape an individual account line (e.g. "Contract
 * Labor" sitting inside a "Payroll Expenses" section) actually has. The
 * original Summary-only matcher can only ever find SUBTOTAL rows like
 * "Total Payroll Expenses" -- it structurally cannot see the individual
 * accounts rolled up into that subtotal, which is exactly why the
 * Contract Labor lookup kept coming back empty even after widening the
 * label list.
 */
function findReportLineItemValueByLabels(node, exactLabelsLowercase) {
  if (!node || typeof node !== 'object') return null;

  if (Array.isArray(node.ColData)) {
    const label = (node.ColData[0]?.value || '').trim().toLowerCase();
    if (exactLabelsLowercase.includes(label)) {
      const raw = node.ColData[1]?.value;
      const num = parseFloat(raw);
      if (!isNaN(num)) return num;
    }
  }

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
      const found = findReportLineItemValueByLabels(row, exactLabelsLowercase);
      if (found !== null) return found;
    }
  }

  return null;
}

/**
 * Collects every line label found anywhere in a report tree, both plain
 * leaf rows (individual accounts) and Summary/subtotal rows, each with
 * its amount. Used purely for diagnostics when a labeled lookup comes up
 * empty, so the real QuickBooks account name (and its actual value, to
 * sanity-check it's the right one) can be seen in the logs instead of
 * guessing blindly at label variants.
 */
function collectAllLineItems(node, out = []) {
  if (!node || typeof node !== 'object') return out;

  if (Array.isArray(node.ColData)) {
    const label = (node.ColData[0]?.value || '').trim();
    const value = node.ColData[1]?.value;
    if (label) out.push({ label, value });
  }
  if (node.Summary && Array.isArray(node.Summary.ColData)) {
    const label = (node.Summary.ColData[0]?.value || '').trim();
    const value = node.Summary.ColData[1]?.value;
    if (label) out.push({ label: `[subtotal] ${label}`, value });
  }

  const rows = node.Rows?.Row || node.Row;
  if (Array.isArray(rows)) {
    for (const row of rows) collectAllLineItems(row, out);
  }
  return out;
}

/**
 * Sums every Chart-of-Accounts entry QuickBooks itself classifies as a
 * labor cost (AccountSubType CostOfLabor or CostOfLaborCos) that had
 * activity on the P&L for the period, rather than guessing at a single
 * account name. Wealthspring's real chart of accounts splits contractor
 * pay across several accounts (Cost of Labor - COS, Payroll Expenses,
 * Wages, Subcontractors, Subcontractors - COS) -- picking just one of
 * them, which the original version of this function did, systematically
 * undercounted. Matching by QuickBooks' own subtype classification
 * (rather than by name) also means this keeps working if the chart of
 * accounts is renamed or reorganized later.
 *
 * Payroll Taxes carries the same subtype but is deliberately excluded --
 * it's an employer tax burden, not compensation paid to a person, and
 * would distort a per-person effective cost/hour figure.
 */
export async function fetchContractLaborSpend(tokens, { startDate, endDate }) {
  const [report, accounts] = await Promise.all([
    qboApiGet(
      `/v3/company/${tokens.realm_id}/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&minorversion=65`,
      tokens
    ),
    fetchLaborRelatedAccounts(tokens),
  ]);

  const laborAccountNames = accounts
    .filter((a) => a.subType === 'CostOfLabor' || a.subType === 'CostOfLaborCos')
    .filter((a) => !a.name.toLowerCase().includes('tax'))
    .map((a) => a.name);

  if (laborAccountNames.length === 0) {
    console.error('Contract Labor: no Cost-of-Labor-subtype accounts found in the Chart of Accounts.');
    return { value: null, source: null };
  }

  let total = 0;
  const sourcesUsed = [];
  for (const name of laborAccountNames) {
    const value = findReportLineItemValueByLabels(report, [name.trim().toLowerCase()]);
    if (value !== null) {
      total += value;
      sourcesUsed.push(name);
    }
  }

  if (sourcesUsed.length === 0) {
    console.error(
      'Contract Labor: labor-subtype accounts exist but none had P&L activity this period:',
      JSON.stringify(laborAccountNames)
    );
    return { value: null, source: null };
  }

  return { value: total, source: sourcesUsed.join(' + ') };
}

/**
 * Sums the current balance of all Bank-type accounts.
 */
/**
 * Finds customers whose QuickBooks record was created within a date range.
 * Used as a proxy "new client" signal for the Pipeline & Sales tab -- there
 * is no CRM tracking prospects/deals in progress, so this captures the
 * point a client relationship became real enough to set their books up,
 * which is the closest thing to a "won" event QuickBooks actually knows
 * about. It is a lagging signal (after the sale), not a true pipeline
 * (deals still in progress) -- there is currently no data source for that.
 */
export async function fetchNewCustomers(tokens, { startDate, endDate }) {
  const query = encodeURIComponent(
    `SELECT Id, DisplayName, MetaData FROM Customer WHERE MetaData.CreateTime >= '${startDate}' AND MetaData.CreateTime <= '${endDate}T23:59:59-00:00' MAXRESULTS 1000`
  );
  const result = await qboApiGet(
    `/v3/company/${tokens.realm_id}/query?query=${query}&minorversion=65`,
    tokens
  );
  const customers = result?.QueryResponse?.Customer || [];
  return customers
    .map((c) => ({
      name: c.DisplayName,
      createdAt: c.MetaData?.CreateTime || null,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Full list of active QuickBooks customers (and sub-customers/jobs),
 * regardless of whether they billed anything this period. Used to check
 * whether a QuickBooks Time job code that couldn't be matched to a
 * billing customer this period is still a real, known QuickBooks
 * customer (just with $0 revenue this period) versus genuinely not in
 * QuickBooks at all -- e.g. a person's name that's actually a contact
 * rather than the billing entity itself.
 */
export async function fetchAllCustomers(tokens) {
  const query = encodeURIComponent(
    `SELECT Id, DisplayName, CompanyName, FullyQualifiedName, ParentRef FROM Customer WHERE Active = true MAXRESULTS 1000`
  );
  const result = await qboApiGet(
    `/v3/company/${tokens.realm_id}/query?query=${query}&minorversion=65`,
    tokens
  );
  const customers = result?.QueryResponse?.Customer || [];
  return customers.map((c) => ({
    name: c.DisplayName,
    companyName: c.CompanyName || null,
    fullyQualifiedName: c.FullyQualifiedName || null,
    parentId: c.ParentRef?.value || null,
  }));
}

/**
 * Diagnostic: pulls every active account in the Chart of Accounts whose
 * name suggests it might hold contractor/labor spend, with its type and
 * current balance. Used to answer, with real data instead of another
 * guess, whether contractor pay is actually split across more than one
 * account (e.g. some under Contract Labor, some under Cost of Labor, some
 * under something else entirely) that fetchContractLaborSpend should be
 * summing together rather than picking just one of.
 */
export async function fetchLaborRelatedAccounts(tokens) {
  const query = encodeURIComponent(
    `SELECT Name, AccountType, AccountSubType, CurrentBalance FROM Account WHERE Active = true MAXRESULTS 1000`
  );
  const result = await qboApiGet(
    `/v3/company/${tokens.realm_id}/query?query=${query}&minorversion=65`,
    tokens
  );
  const accounts = result?.QueryResponse?.Account || [];
  const keywords = ['labor', 'contract', 'subcontract', '1099', 'outside service', 'payroll', 'wages', 'salaries', 'cost of'];
  return accounts
    .filter((a) => keywords.some((kw) => (a.Name || '').toLowerCase().includes(kw)))
    .map((a) => ({
      name: a.Name,
      type: a.AccountType,
      subType: a.AccountSubType || null,
      currentBalance: a.CurrentBalance ?? null,
    }));
}

export async function fetchCashBalance(tokens) {
  const query = encodeURIComponent("SELECT * FROM Account WHERE AccountType = 'Bank'");
  const result = await qboApiGet(
    `/v3/company/${tokens.realm_id}/query?query=${query}&minorversion=65`,
    tokens
  );
  const accounts = result?.QueryResponse?.Account || [];
  const total = accounts.reduce((sum, acct) => sum + (acct.CurrentBalance || 0), 0);

  // A combined total across several accounts can land near zero (or even
  // negative) while every individual account looks fine on its own -- one
  // account running negative is enough to drag the whole sum down. That's
  // real, not a bug, but showing only the opaque total makes it look
  // broken. Returning each account's own balance too lets the UI show
  // the actual breakdown, sorted most-negative-first so anything unusual
  // is immediately visible rather than buried in the total.
  const breakdown = accounts
    .map((a) => ({ name: a.Name, balance: Math.round((a.CurrentBalance || 0) * 100) / 100 }))
    .sort((a, b) => a.balance - b.balance);

  return { total: Math.round(total * 100) / 100, breakdown };
}
