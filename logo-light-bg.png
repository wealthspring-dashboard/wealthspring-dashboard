import { buildClearSessionCookie } from '../lib/session.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': buildClearSessionCookie(),
    },
  });
}
