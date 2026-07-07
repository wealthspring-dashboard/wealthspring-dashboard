import { verifySessionToken, getCookie, COOKIE_NAME } from '../lib/session.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const sessionSecret = process.env.SESSION_SECRET;
  const token = getCookie(request, COOKIE_NAME);
  const authenticated = sessionSecret ? await verifySessionToken(token, sessionSecret) : false;

  return new Response(JSON.stringify({ authenticated }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
