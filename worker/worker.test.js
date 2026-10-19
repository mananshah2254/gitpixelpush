import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import worker from "./worker.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const env = {
  GITHUB_CLIENT_ID: "test-client",
  GITHUB_CLIENT_SECRET: "test-secret",
  ALLOWED_ORIGINS: "https://preview.example",
};

function request(origin, body = { code: "valid-code" }) {
  return new Request("https://gitpixelpush.com/exchange", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("rejects a disallowed origin without contacting GitHub", async () => {
  globalThis.fetch = () => { throw new Error("should not call GitHub"); };
  const response = await worker.fetch(request("https://untrusted.example"), env);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "origin_not_allowed" });
});

test("rejects an invalid code without contacting GitHub", async () => {
  globalThis.fetch = () => { throw new Error("should not call GitHub"); };
  const response = await worker.fetch(request("https://gitpixelpush.com", { code: 42 }), env);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "missing_code" });
});

test("returns a valid token with no-store and the allowed origin", async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://github.com/login/oauth/access_token");
    assert.deepEqual(JSON.parse(options.body), {
      client_id: "test-client", client_secret: "test-secret", code: "valid-code",
    });
    return Response.json({ access_token: "test-token", token_type: "bearer", scope: "public_repo" });
  };
  const response = await worker.fetch(request("https://preview.example"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://preview.example");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    access_token: "test-token", token_type: "bearer", scope: "public_repo",
  });
});

test("treats a successful upstream response without a token as a failure", async () => {
  globalThis.fetch = async () => Response.json({ scope: "public_repo" });
  const response = await worker.fetch(request("https://gitpixelpush.com"), env);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "exchange_failed" });
});
