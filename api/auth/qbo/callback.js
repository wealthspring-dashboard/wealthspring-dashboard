import { exchangeCodeForTokens } from '../../../lib/qbo.js';
import { setQboTokens } from '../../../lib/kv.js';
import { getCookie } from '../../../lib/session.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const realmId = url.searchParams.get('realmId');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  const dashboardUrl = new URL('/', request.url);

  if (error) {
    dashboardUrl.searchParams.set('qbo_error', error);
    return Response.redirect(dashboardUrl, 302);
  }

  const expectedState = getCookie(request, 'qbo_oauth_state');
  if (!state || !expectedState || state !== expectedState) {
    dashboardUrl.searchParams.set('qbo_error', 'state_mismatch');
    return Response.redirect(dashboardUrl, 302);
  }

  if (!code || !realmId) {
    dashboardUrl.searchParams.set('qbo_error', 'missing_code_or_realm');
    return Response.redirect(dashboardUrl, 302);
  }

  const clientId = process.env.QBO_CLIENT_ID;
  const clientSecret = process.env.QBO_CLIENT_SECRET;
  const redirectUri = process.env.QBO_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    dashboardUrl.searchParams.set('qbo_error', 'server_not_configured');
    return Response.redirect(dashboardUrl, 302);
  }

  try {
    const tokens = await exchangeCodeForTokens({ code, redirectUri, clientId, clientSecret, realmId });
    await setQboTokens(tokens);
  } catch (e) {
    dashboardUrl.searchParams.set('qbo_error', 'token_exchange_failed');
    return Response.redirect(dashboardUrl, 302);
  }

  dashboardUrl.searchParams.set('qbo_connected', '1');

  const clearStateCookie = 'qbo_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

  return new Response(null, {
    status: 302,
    headers: {
      Location: dashboardUrl.toString(),
      'Set-Cookie': clearStateCookie,
    },
  });
}
