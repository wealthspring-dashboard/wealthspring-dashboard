import { getQbTimeAuthorizationUrl } from '../../../lib/qbotime.js';

export const config = { runtime: 'edge' };

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export default async function handler(request) {
  const clientId = process.env.QBTIME_CLIENT_ID;
  const redirectUri = process.env.QBTIME_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return new Response('QuickBooks Time is not configured yet (missing QBTIME_CLIENT_ID or QBTIME_REDIRECT_URI).', {
      status: 500,
    });
  }

  const state = randomState();
  const authUrl = getQbTimeAuthorizationUrl({ clientId, redirectUri, state });

  const stateCookie = [
    `qbtime_oauth_state=${state}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=600',
  ].join('; ');

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      'Set-Cookie': stateCookie,
    },
  });
}
