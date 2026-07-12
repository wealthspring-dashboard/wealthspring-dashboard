import { clearQboTokens } from '../../../lib/kv.js';

export const config = { runtime: 'edge' };

/**
 * Disconnects QuickBooks by clearing the stored tokens. This does NOT revoke
 * the OAuth grant on Intuit's side (that would require a separate revoke
 * API call) -- it simply forgets our copy of the tokens, so the dashboard
 * stops pulling data and the "Connect QuickBooks" flow can be started fresh.
 * That matches what a single-company internal tool actually needs: a clean
 * way to disconnect and reconnect, not full deauthorization bookkeeping.
 */
export default async function handler(request) {
  await clearQboTokens();

  const dashboardUrl = new URL('/', request.url);
  dashboardUrl.searchParams.set('qbo_disconnected', '1');

  return new Response(null, {
    status: 302,
    headers: { Location: dashboardUrl.toString() },
  });
}
