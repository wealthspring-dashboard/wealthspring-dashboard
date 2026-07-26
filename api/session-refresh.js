import { createSessionToken, buildSessionCookie } from '../lib/session.js';

export const config = { runtime: 'edge' };

/**
 * Extends an already-authenticated session by another hour. Not in
 * middleware.js's PUBLIC_PATHS, so middleware has already verified the
 * request carries a valid session cookie before this handler ever runs --
 * no need to re-check the password or re-verify here, just issue a fresh
 * token with a renewed expiry.
 *
 * Called periodically by the frontend (see startSessionKeepAlive in
 * index.html) only while the tab is open and visible. Stop using the
 * dashboard -- close the tab, close the browser, or just leave it in a
 * background tab long enough -- and nothing calls this anymore, so the
 * 1-hour expiry set in lib/session.js is left to run out on its own.
 */
export default async function handler(request) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    return new Response(JSON.stringify({ error: 'Server is not configured.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = await createSessionToken(sessionSecret);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': buildSessionCookie(token),
    },
  });
}
