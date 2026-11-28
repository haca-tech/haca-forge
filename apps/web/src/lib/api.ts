export class ApiError extends Error {
  code: string;
  statusCode: number;
  details?: any;

  constructor(
    message: string,
    code = "UNKNOWN_ERROR",
    statusCode = 500,
    details?: any,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

let refreshPromise: Promise<boolean> | null = null;

/**
 * Resolves the full URL for an API endpoint using VITE_API_BASE_URL when defined,
 * or falling back to relative /api paths. Avoids duplicate /api prefixes.
 */
export function buildApiUrl(endpoint: string): string {
  // With VITE_API_SAME_ORIGIN=true the web host forwards /api to the API, so requests and the login
  // cookie stay on the web app's own domain (browsers that block third-party cookies, such as
  // Safari, keep the session). Otherwise requests go to VITE_API_BASE_URL.
  return joinApiUrl(sameOriginApi() ? "" : configuredApiBase(), endpoint);
}

/** The API host itself (VITE_API_BASE_URL), for the requests the web host cannot forward well:
 *  the live socket and large uploads. They authenticate with a short-lived token (/auth/direct-token). */
export function buildDirectApiUrl(endpoint: string): string {
  return joinApiUrl(configuredApiBase(), endpoint);
}

/** Origin of the API host ("" when it is this site). */
export function directApiOrigin(): string {
  const base = configuredApiBase();
  try {
    return base ? new URL(base).origin : "";
  } catch {
    return "";
  }
}

function configuredApiBase(): string {
  return (import.meta.env?.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");
}

/**
 * Same-origin /api only when VITE_API_SAME_ORIGIN=true, i.e. the web host really forwards /api to
 * the API (a Cloudflare Pages Function or a Vercel rewrite). Without that forwarding, /api on the
 * web host answers 405 and nobody can sign in, so the default is the API host (VITE_API_BASE_URL).
 */
function sameOriginApi(): boolean {
  return String(import.meta.env?.VITE_API_SAME_ORIGIN || "").toLowerCase() === "true" && !proxyUnavailable();
}

/**
 * Safety net: if /api on the web host does not reach the API (a 404/405 page instead of the API's
 * JSON, e.g. the Pages Function is not deployed), use the API host directly for the rest of this
 * browser session, so nobody is locked out. A new session tries the proxy again.
 */
const PROXY_OFF_KEY = "haca.apiProxyOff";
let proxyOff = false;
function proxyUnavailable(): boolean {
  if (proxyOff) return true;
  try {
    proxyOff = typeof window !== "undefined" && window.sessionStorage?.getItem(PROXY_OFF_KEY) === "1";
  } catch {
    /* storage unavailable */
  }
  return proxyOff;
}
function markProxyUnavailable(): void {
  proxyOff = true;
  try {
    window.sessionStorage?.setItem(PROXY_OFF_KEY, "1");
  } catch {
    /* storage unavailable */
  }
}
/** A response from the web host itself rather than the API behind /api. */
function isMissingProxy(response: Response): boolean {
  const type = response.headers.get("content-type") || "";
  return (response.status === 404 || response.status === 405) && !type.includes("application/json");
}

/** A short-lived token for a request sent straight to the API host ("socket" or "upload"). */
export async function getDirectToken(purpose: "socket" | "upload"): Promise<string | null> {
  try {
    const res = await apiFetch<{ data?: { token?: string } }>(`/auth/direct-token?purpose=${purpose}`);
    return res?.data?.token || null;
  } catch {
    return null;
  }
}

function joinApiUrl(rawBaseIn: string, endpoint: string): string {
  if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
    return endpoint;
  }

  const rawBase = rawBaseIn;
  const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

  if (!rawBase) {
    return cleanEndpoint.startsWith("/api") ? cleanEndpoint : `/api${cleanEndpoint}`;
  }

  if (rawBase.endsWith("/api")) {
    if (cleanEndpoint === "/api") return rawBase;
    if (cleanEndpoint.startsWith("/api/")) return `${rawBase}${cleanEndpoint.slice(4)}`;
    return `${rawBase}${cleanEndpoint}`;
  }

  if (cleanEndpoint.startsWith("/api")) {
    return `${rawBase}${cleanEndpoint}`;
  }
  return `${rawBase}/api${cleanEndpoint}`;
}

function isAuthEndpoint(url: string): boolean {
  return (
    url.includes("/auth/login") ||
    url.includes("/auth/refresh") ||
    url.includes("/auth/set-password") ||
    url.includes("/auth/forgot-password")
  );
}

/**
 * Login tokens live only in httpOnly cookies set by the API, never in browser storage.
 * Older builds kept copies in localStorage; this removes any that are left.
 */
const LEGACY_TOKEN_KEYS = ["accessToken", "refreshToken", "token"];

export function clearLegacyTokens(): void {
  if (typeof window === "undefined") return;
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      const store = window[name];
      for (const key of LEGACY_TOKEN_KEYS) store?.removeItem(key);
    } catch {
      // Storage can be unavailable (private mode, tests); nothing to clear then.
    }
  }
}

async function executeTokenRefresh(): Promise<boolean> {
  try {
    // The refresh cookie is sent automatically; the API answers with new cookies.
    const send = () => fetch(buildApiUrl("/auth/refresh"), { method: "POST", credentials: "include" });
    let res = await send();
    if (sameOriginApi() && isMissingProxy(res)) {
      markProxyUnavailable();
      res = await send();
    }
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Renew the access cookie once, shared by every caller that hits an expired session
 * at the same moment (REST, uploads, the socket).
 */
export function refreshSession(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = executeTokenRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function apiFetch<T = any>(
  endpoint: string,
  options: RequestInit & { _isRetry?: boolean } = {},
): Promise<T> {
  const url = buildApiUrl(endpoint);

  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type") && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const { _isRetry, ...fetchOptions } = options;

  const doFetch = () =>
    fetch(url, {
      ...fetchOptions,
      headers,
      credentials: "include", // Ensure cookies are sent
    });

  // While the API is (re)starting, the dev proxy answers 503 SERVER_RESTARTING.
  // Wait and retry quietly for a few seconds instead of surfacing an error.
  // Skipped for FormData/streams, whose bodies can't be re-sent.
  const canRetryBody =
    fetchOptions.body == null || typeof fetchOptions.body === "string";
  let response = await doFetch();
  for (let i = 0; i < 6 && response.status === 503 && canRetryBody; i++) {
    const code = await response
      .clone()
      .json()
      .then((d) => d?.error?.code)
      .catch(() => undefined);
    if (code !== "SERVER_RESTARTING") break;
    await new Promise((r) => setTimeout(r, 1000));
    response = await doFetch();
  }

  // /api on the web host did not reach the API: switch to the API host and send this request again.
  if (sameOriginApi() && !/^https?:/.test(url) && isMissingProxy(response) && canRetryBody) {
    markProxyUnavailable();
    return apiFetch<T>(endpoint, options);
  }

  // Handle silent token refresh on 401 Unauthorized
  if (response.status === 401 && !isAuthEndpoint(url) && !_isRetry) {
    const refreshed = await refreshSession();
    if (refreshed) {
      return apiFetch<T>(endpoint, { ...options, _isRetry: true });
    }

    // Refresh failed - the session is over; go to login
    if (typeof window !== "undefined") {
      clearLegacyTokens();
      if (
        window.location &&
        !window.location.pathname.startsWith("/login") &&
        !window.location.pathname.startsWith("/set-password")
      ) {
        try {
          const returnUrl = encodeURIComponent(
            window.location.pathname + window.location.search,
          );
          window.location.href = `/login?from=${returnUrl}`;
        } catch {
          // Navigation not implemented in test environments (e.g. jsdom)
        }
      }
    }
  }

  // Try parsing JSON
  let data: any = null;
  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const errorPayload = data?.error;
    throw new ApiError(
      errorPayload?.message || response.statusText || "Request failed",
      errorPayload?.code || `HTTP_${response.status}`,
      response.status,
      errorPayload?.details,
    );
  }

  return data as T;
}

/**
 * Downloads a file from the API and saves it under `filename`.
 *
 * A plain <a href download> link cannot renew an expired login, and when the request fails the
 * browser still saves the error text under the file's name (Excel then reports "the file format
 * or file extension is not valid"). This goes through the same cookie and renewal as apiFetch,
 * and only saves the response when it really is a file; otherwise it throws an ApiError with the
 * server's message.
 */
export async function apiDownload(endpoint: string, filename: string, _isRetry = false): Promise<void> {
  const url = buildApiUrl(endpoint);
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include" });
  } catch {
    throw new ApiError("Could not reach the server. Check your connection and try again.", "NETWORK_ERROR", 0);
  }

  if (response.status === 401 && !_isRetry && (await refreshSession())) {
    return apiDownload(endpoint, filename, true);
  }

  const type = response.headers.get("content-type") || "";
  if (!response.ok || type.includes("application/json") || type.includes("text/html")) {
    let message = response.status === 401 ? "Your session has ended. Sign in again, then download the file." : "The file could not be downloaded. Try again.";
    if (type.includes("application/json")) {
      try {
        const body = await response.json();
        if (body?.error?.message && response.status !== 401) message = body.error.message;
      } catch {
        /* keep the generic message */
      }
    }
    throw new ApiError(message, `HTTP_${response.status}`, response.status);
  }

  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
