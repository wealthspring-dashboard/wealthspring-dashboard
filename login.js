import { getAuthorizationUrl } from '../../../lib/qbo.js';

export const config = { runtime: 'edge' };

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export default async function handler(request) {
  const clientId = process.env.QBO_CLIENT_ID;
  const redirectUri = process.env.QBO_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return new Response('QuickBooks is not configured yet (missing QBO_CLIENT_ID or QBO_REDIRECT_URI).', {
      status: 500,
    });
  }

  const state = randomState();
  const authUrl = getAuthorizationUrl({ clientId, redirectUri, state });

  // Short-lived cookie so the callback can verify this request actually
  // originated from us (CSRF protection on the OAuth flow).
  const stateCookie = [
    `qbo_oauth_state=${state}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=600', // 10 minutes is plenty to complete the Intuit login screen
  ].join('; ');

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl,
      'Set-Cookie': stateCookie,
    },
  });
}
