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

async function qboApiGet(path, tokens) {
  const url = `${apiBase()}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json',
    },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) {
    const detail = json ? JSON.stringify(json) : `HTTP ${res.status}`;
    throw new Error(`QuickBooks API request failed (${path}): ${detail}`);
  }
  return json;
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
 * Fetches this month's Profit & Loss summary: total revenue and net income.
 * NOTE: QBO's exact report JSON labels can vary slightly by company/locale
 * settings. This searches by pattern rather than a fixed path, but should
 * be spot-checked against a real report once QuickBooks is connected.
 */
// Supported periods: 'month' (default), 'quarter', 'year' -- all "period to
// date" (e.g. 'quarter' means "1st day of this fiscal quarter through today",
// not a full completed quarter).
function getDateRangeForPeriod(period) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed
  const pad = (n) => String(n).padStart(2, '0');
  const endDate = now.toISOString().slice(0, 10);

  if (period === 'quarter') {
    const quarterStartMonth = Math.floor(month / 3) * 3;
    return { startDate: `${year}-${pad(quarterStartMonth + 1)}-01`, endDate };
  }

  if (period === 'year') {
    return { startDate: `${year}-01-01`, endDate };
  }

  return { startDate: `${year}-${pad(month + 1)}-01`, endDate };
}

export async function fetchProfitAndLossSummary(tokens, period = 'month') {
  const { startDate, endDate } = getDateRangeForPeriod(period);

  const report = await qboApiGet(
    `/v3/company/${tokens.realm_id}/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&minorversion=65`,
    tokens
  );

  const totalRevenue = findReportSummaryValue(report, /total\s*income/i);
  const netIncome = findReportSummaryValue(report, /net\s*income/i);

  const netProfitMargin =
    totalRevenue && netIncome !== null && totalRevenue !== 0
      ? Math.round((netIncome / totalRevenue) * 1000) / 10
      : null;

  return { totalRevenue, netIncome, netProfitMargin, period, startDate, endDate };
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
