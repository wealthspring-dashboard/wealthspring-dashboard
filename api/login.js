import { createSessionToken, buildSessionCookie } from '../lib/session.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const sessionSecret = process.env.SESSION_SECRET;
  const dashboardPassword = process.env.DASHBOARD_PASSWORD;

  if (!sessionSecret || !dashboardPassword) {
    return new Response(
      JSON.stringify({ error: 'Server is not configured. Missing SESSION_SECRET or DASHBOARD_PASSWORD.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { password } = body || {};

  const match =
    typeof password === 'string' &&
    password.length === dashboardPassword.length &&
    password
      .split('')
      .reduce((diff, ch, i) => diff | (ch.charCodeAt(0) ^ dashboardPassword.charCodeAt(i)), 0) === 0;

  if (!match) {
    return new Response(JSON.stringify({ error: 'Incorrect password' }), {
      status: 401,
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
