import { clearQbTimeTokens } from '../../../lib/kv.js';

export const config = { runtime: 'edge' };

/**
 * Clears the stored QuickBooks Time tokens. Same shape as the QBO
 * disconnect endpoint: forgets our copy of the tokens so Team & Operations
 * stops pulling hours and shows a clean "not connected" state, without
 * attempting to revoke the grant on QuickBooks Time's side.
 */
export default async function handler(request) {
  await clearQbTimeTokens();

  const dashboardUrl = new URL('/', request.url);
  dashboardUrl.searchParams.set('qbtime_disconnected', '1');

  return new Response(null, {
    status: 302,
    headers: { Location: dashboardUrl.toString() },
  });
}
