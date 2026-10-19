/**
 * GitPixelPush OAuth exchange Worker.
 *
 * One job: swap a GitHub OAuth `code` for an access token, because that step
 * needs the client secret and must not happen in the browser. The token is
 * returned straight to the caller and never stored or logged here.
 */

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (origin === new URL(request.url).origin) return origin; // same-origin site
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function json(body, status, origin) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);

    if (request.method === "OPTIONS") {
      return json(null, origin ? 204 : 403, origin);
    }

    if (url.pathname !== "/exchange" || request.method !== "POST") {
      return json({ error: "not_found" }, 404, origin);
    }
    if (!origin) {
      return json({ error: "origin_not_allowed" }, 403, null);
    }

    let code = null;
    try {
      ({ code } = await request.json());
    } catch {
      /* fall through to validation */
    }
    if (!code || typeof code !== "string" || code.length > 200) {
      return json({ error: "missing_code" }, 400, origin);
    }

    try {
      const r = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "GitPixelPush-oauth-worker",
        },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
        }),
      });
      const data = await r.json(); // GitHub's response here is a few hundred bytes
      if (!r.ok || data.error) {
        return json({ error: data.error || "exchange_failed" }, 400, origin);
      }
      if (!data.access_token || typeof data.access_token !== "string") {
        return json({ error: "exchange_failed" }, 502, origin);
      }
      return json(
        {
          access_token: data.access_token,
          token_type: data.token_type,
          scope: data.scope,
        },
        200,
        origin,
      );
    } catch (e) {
      console.log(JSON.stringify({ event: "exchange_error", message: String(e) }));
      return json({ error: "upstream_unreachable" }, 502, origin);
    }
  },
};
