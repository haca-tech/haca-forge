import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Production builds call /api on the web app's own domain (a Cloudflare Pages Function forwards it
// to the API). If that forwarding is missing, /api answers 405/404 from the web host: the app must
// switch to the API host instead of locking everyone out (what happened on 28 Nov 2026).
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('API proxy fallback', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_SAME_ORIGIN', 'true');
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/api');
    const store: Record<string, string> = {};
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: (globalThis as any).sessionStorage });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses /api on the same site when the proxy answers', async () => {
    const fetchMock = vi.fn(async (_url: string) => json(200, { data: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = await import('../api');
    await apiFetch('/auth/me');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/me');
  });

  it('a 405 page from the web host switches to the API host and resends the request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 405 }))
      .mockResolvedValue(json(200, { data: { user: 'ok' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch, buildApiUrl } = await import('../api');
    const res = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'a', password: 'b' }) });
    expect(res).toEqual({ data: { user: 'ok' } });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/auth/login', 'https://api.example.com/api/auth/login']);
    expect(buildApiUrl('/auth/me')).toBe('https://api.example.com/api/auth/me'); // for the rest of the session
  });

  it('a JSON 404 from the API itself is a normal error, not a missing proxy', async () => {
    const fetchMock = vi.fn(async () => json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { apiFetch } = await import('../api');
    await expect(apiFetch('/work/x')).rejects.toMatchObject({ statusCode: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
