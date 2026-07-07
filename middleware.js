// Thin wrapper around Vercel KV for storing QuickBooks tokens.
//
// This is a single-tenant tool (one shared team password, one connected
// QuickBooks company), so we store tokens under one fixed key rather than
// per-user -- there's only ever one QuickBooks connection for the whole team.

import { kv } from '@vercel/kv';

const QBO_TOKENS_KEY = 'wfs:qbo:tokens';

/**
 * @returns {Promise<null | {
 *   access_token: string,
 *   refresh_token: string,
 *   expires_at: number,   // ms epoch
 *   realm_id: string
 * }>}
 */
export async function getQboTokens() {
  const data = await kv.get(QBO_TOKENS_KEY);
  return data || null;
}

export async function setQboTokens(tokens) {
  await kv.set(QBO_TOKENS_KEY, tokens);
}

export async function clearQboTokens() {
  await kv.del(QBO_TOKENS_KEY);
}
