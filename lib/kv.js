// Thin wrapper around Upstash Redis (Vercel's current recommended storage
// integration, replacing the discontinued "Vercel KV" product) for storing
// QuickBooks tokens.
//
// This is a single-tenant tool (one shared team password, one connected
// QuickBooks company), so we store tokens under one fixed key rather than
// per-user -- there's only ever one QuickBooks connection for the whole team.
//
// Redis.fromEnv() auto-detects credentials from either KV_REST_API_URL /
// KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN,
// so this works regardless of which env var names Vercel's Upstash
// Marketplace integration sets.

import { Redis } from '@upstash/redis';

const kv = Redis.fromEnv();

const QBO_TOKENS_KEY = 'wfs:qbo:tokens';

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

// Separate key namespace -- QuickBooks Time is a completely different
// product/API from QuickBooks Online Accounting, with its own credentials
// and its own token lifecycle, so its tokens are stored independently and
// never touch the QBO connection above.
const QBTIME_TOKENS_KEY = 'wfs:qbtime:tokens';

export async function getQbTimeTokens() {
  const data = await kv.get(QBTIME_TOKENS_KEY);
  return data || null;
}

export async function setQbTimeTokens(tokens) {
  await kv.set(QBTIME_TOKENS_KEY, tokens);
}

export async function clearQbTimeTokens() {
  await kv.del(QBTIME_TOKENS_KEY);
}
