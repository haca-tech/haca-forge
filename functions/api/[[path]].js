/**
 * Cloudflare Pages Function: forwards /api/* on the web app's own domain to the API on Render.
 *
 * Why: the API is on another site (onrender.com). Its login cookie was third-party there, and
 * Safari (every iPhone browser), Brave and incognito windows drop third-party cookies, so people
 * were sent back to the login page right after signing in. Through this proxy the cookie belongs
 * to the web app's domain. The live socket and large uploads still go straight to the API with
 * short-lived tokens (apps/api/src/lib/directTokens.js).
 *
 * The same file exists at the repo root and in apps/web: Cloudflare uses the one in the Pages
 * project's root directory.
 */
const DEFAULT_API_ORIGIN = 'https://mmp-api-t3z8.onrender.com';

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const apiOrigin = (env && env.API_ORIGIN) || DEFAULT_API_ORIGIN;
  const target = new URL(url.pathname + url.search, apiOrigin);

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.set('X-Forwarded-Host', url.host);
  headers.set('X-Forwarded-Proto', 'https');
  // The visitor's IP (set by Cloudflare, not by the browser), so the API's rate limits see people, not this proxy.
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) headers.set('X-Forwarded-For', ip);
  else headers.delete('X-Forwarded-For');

  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const response = await fetch(target.toString(), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
  });

  // Pass the API's answer through unchanged (status, Set-Cookie, body).
  return new Response(response.body, response);
}
