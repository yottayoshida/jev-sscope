// Front door. Two tokens: one for the hook that posts steps, one for the person
// who looks at them. Nothing is served to anyone who has neither.

import type { Env } from "./hub";
export { Hub } from "./hub";

const INGEST_MAX_BYTES = 256 * 1024;
const COOKIE = "jev_view";
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
const TOKEN_MIN_CHARS = 32;
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

/** Two long, different secrets, or nothing is served at all. */
function configured(env: Env): boolean {
  return (
    typeof env.INGEST_TOKEN === "string" &&
    typeof env.VIEW_TOKEN === "string" &&
    env.INGEST_TOKEN.length >= TOKEN_MIN_CHARS &&
    env.VIEW_TOKEN.length >= TOKEN_MIN_CHARS &&
    env.INGEST_TOKEN !== env.VIEW_TOKEN
  );
}

/** Equal or not, in the same time either way. */
function sameSecret(given: string | null | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) {
    crypto.subtle.timingSafeEqual(b, b);
    return false;
  }
  return crypto.subtle.timingSafeEqual(a, b);
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function deny(status: number, text: string): Response {
  return new Response(`${text}\n`, { status, headers: { "Content-Type": "text/plain", ...SECURITY_HEADERS } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!configured(env)) return deny(503, "not configured");
    const hub = env.HUB.getByName("hub");

    if (url.pathname === "/ingest") {
      if (request.method !== "POST") return deny(405, "method not allowed");
      if (!sameSecret(bearer(request), env.INGEST_TOKEN)) return deny(401, "unauthorized");
      const declared = Number(request.headers.get("Content-Length") ?? 0);
      if (declared > INGEST_MAX_BYTES) return deny(413, "too large");
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > INGEST_MAX_BYTES) return deny(413, "too large");
      const text = new TextDecoder().decode(bytes);
      try {
        JSON.parse(text);
      } catch {
        return deny(400, "not json");
      }
      return hub.fetch(new Request("https://hub/ingest", { method: "POST", body: text, headers: { "Content-Type": "application/json" } }));
    }

    // The viewer's token arrives once, in the URL, and moves into a cookie so it
    // does not stay in the address bar, the history or the logs.
    const presented = url.searchParams.get("t");
    if (presented !== null) {
      if (!sameSecret(presented, env.VIEW_TOKEN)) return deny(401, "unauthorized");
      const secure = url.protocol === "https:" ? "; Secure" : "";
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": `${COOKIE}=${presented}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${secure}`,
          ...SECURITY_HEADERS,
        },
      });
    }
    if (!sameSecret(cookie(request, COOKIE), env.VIEW_TOKEN)) return deny(401, "unauthorized");

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return deny(426, "upgrade required");
      // Browsers always send Origin on an upgrade; a page elsewhere must not ride the cookie.
      if (request.headers.get("Origin") !== url.origin) return deny(403, "forbidden");
      return hub.fetch(request);
    }
    if (url.pathname === "/sessions" || url.pathname === "/history") {
      const response = await hub.fetch(new Request(`https://hub${url.pathname}${url.search}`));
      return withHeaders(response);
    }
    return withHeaders(await env.ASSETS.fetch(request));
  },
};

function withHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(key, value);
  return out;
}
