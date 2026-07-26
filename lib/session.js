// Shared session-token helpers.
//
// Uses only standard Web APIs (crypto.subtle, TextEncoder/Decoder, atob/btoa)
// so this exact same code runs unmodified in both:
//   - Edge Middleware (middleware.js)
//   - Edge Functions   (api/*.js)
//
// Token format: `<base64url(payload json)>.<base64url(hmac-sha256 signature)>`
// Payload only ever contains an expiry timestamp -- there is no per-user data
// to leak since this project uses a single shared team password.

const COOKIE_NAME = 'wfs_session';
const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 12; // 12 hours -- long enough to cover a workday without re-login, short enough that a shared/lost device doesn't stay signed in for weeks. Was previously 30 days, far too permissive for a dashboard showing real financial data.

function bytesToBase64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function sign(payloadB64, secret) {
  const key = await importHmacKey(secret);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return bytesToBase64url(new Uint8Array(sigBuf));
}

export async function createSessionToken(secret, maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS) {
  const payload = JSON.stringify({ exp: Date.now() + maxAgeSeconds * 1000 });
  const payloadB64 = bytesToBase64url(new TextEncoder().encode(payload));
  const sigB64 = await sign(payloadB64, secret);
  return `${payloadB64}.${sigB64}`;
}

export async function verifySessionToken(token, secret) {
  try {
    if (!token || typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [payloadB64, sigB64] = parts;
    if (!payloadB64 || !sigB64) return false;

    const expectedSigB64 = await sign(payloadB64, secret);

    if (expectedSigB64.length !== sigB64.length) return false;
    let diff = 0;
    for (let i = 0; i < expectedSigB64.length; i++) {
      diff |= expectedSigB64.charCodeAt(i) ^ sigB64.charCodeAt(i);
    }
    if (diff !== 0) return false;

    const payloadJson = new TextDecoder().decode(base64urlToBytes(payloadB64));
    const payload = JSON.parse(payloadJson);
    if (!payload || typeof payload.exp !== 'number') return false;
    if (Date.now() > payload.exp) return false;

    return true;
  } catch (e) {
    return false;
  }
}

export function getCookie(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  const match = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

export function buildSessionCookie(token) {
  // No Max-Age/Expires on purpose -- this makes it a session cookie, which
  // most browsers clear when the browser itself is fully closed (not just
  // a tab), so closing out requires the password again next time. The
  // token's own signed expiry (DEFAULT_MAX_AGE_SECONDS, checked in
  // verifySessionToken) is a separate server-side safety net in case a
  // browser's session-restore feature keeps the cookie around longer than
  // expected -- that's a per-browser setting we can't fully control from
  // here, so it's not a hard guarantee, just the best a cookie can do.
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ];
  return attrs.join('; ');
}

export function buildClearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export { COOKIE_NAME };
