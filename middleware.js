import { verifySessionToken, getCookie, COOKIE_NAME } from './lib/session.js';

export const config = {
  // Run on everything except static assets, which must always be loadable
  // (the login page needs its logo/background even before you're authenticated).
  matcher: ['/((?!assets/|favicon.ico).*)'],
};

// Paths that must always be reachable without a valid session, or nobody
// could ever log in (and logout/session-check need to work regardless of
// current auth state).
const PUBLIC_PATHS = new Set(['/login.html', '/api/login', '/api/logout', '/api/session']);

export default async function middleware(request) {
  const url = new URL(request.url);

  if (PUBLIC_PATHS.has(url.pathname)) {
    return; // let it through unmodified
  }

  const sessionSecret = process.env.SESSION_SECRET;
  const token = getCookie(request, COOKIE_NAME);
  const authenticated = sessionSecret ? await verifySessionToken(token, sessionSecret) : false;

  if (authenticated) {
    return; // let it through unmodified
  }

  // API requests get a clean 401 rather than an HTML redirect.
  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Everything else (the dashboard page itself) redirects to the login screen,
  // preserving where the user was headed so we can send them back after login.
  const redirectUrl = new URL('/login.html', request.url);
  redirectUrl.searchParams.set('next', url.pathname);
  return Response.redirect(redirectUrl, 307);
}
