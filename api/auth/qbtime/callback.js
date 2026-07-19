import { exchangeQbTimeCodeForTokens } from '../../../lib/qbotime.js';
import { setQbTimeTokens } from '../../../lib/kv.js';
import { getCookie } from '../../../lib/session.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  const dashboardUrl = new URL('/', request.url);

  if (error) {
    dashboardUrl.searchParams.set('qbtime_error', error);
    return Response.redirect(dashboardUrl, 302);
  }

  const expectedState = getCookie(request, 'qbtime_oauth_state');
  if (!state || !expectedState || state !== expectedState) {
    dashboardUrl.searchParams.set('qbtime_error', 'state_mismatch');
    return Response.redirect(dashboardUrl, 302);
  }

  if (!code) {
    dashboardUrl.searchParams.set('qbtime_error', 'missing_code');
    return Response.redirect(dashboardUrl, 302);
  }

  const clientId = process.env.QBTIME_CLIENT_ID;
  const clientSecret = process.env.QBTIME_CLIENT_SECRET;
  const redirectUri = process.env.QBTIME_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    dashboardUrl.searchParams.set('qbtime_error', 'server_not_configured');
    return Response.redirect(dashboardUrl, 302);
  }

  try {
    const tokens = await exchangeQbTimeCodeForTokens({ code, redirectUri, clientId, clientSecret });
    await setQbTimeTokens(tokens);
  } catch (e) {
    dashboardUrl.searchParams.set('qbtime_error', 'token_exchange_failed');
    return Response.redirect(dashboardUrl, 302);
  }

  dashboardUrl.searchParams.set('qbtime_connected', '1');

  const clearStateCookie = 'qbtime_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';

  return new Response(null, {
    status: 302,
    headers: {
      Location: dashboardUrl.toString(),
      'Set-Cookie': clearStateCookie,
    },
  });
}
