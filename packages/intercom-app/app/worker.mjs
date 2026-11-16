// Cloudflare Worker front end for the Canvas Kit webhooks: verify Intercom's signature, hand the
// request to the app, answer with a canvas. An error here still returns a canvas, because
// Intercom is waiting for one, and the teammate's reply is never held up by us either way.

import { handleCanvasRequest, runtimeFrom } from "./assets/main.mjs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const canvasSaying = (message) =>
  json({ canvas: { content: { components: [{ type: "text", text: message, style: "muted" }] } } });

/** Intercom signs every Canvas Kit request: HMAC-SHA256 over the raw body with the app's client secret. */
async function validSignature(rawBody, header, secret) {
  if (!header) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== header.length) return false;
  // Constant-time compare: a rejected signature must not leak how much of it matched.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

/** The same keys `settingsFrom` reads, taken from the worker's environment. */
const CONFIG_KEYS = {
  overturn_api_key: "OVERTURN_API_KEY",
  overturn_base_url: "OVERTURN_BASE_URL",
  agent: "OVERTURN_AGENT",
  reason_pack: "OVERTURN_REASON_PACK",
  require_reason: "OVERTURN_REQUIRE_REASON",
  capture_notes: "OVERTURN_CAPTURE_NOTES",
  min_draft_chars: "OVERTURN_MIN_DRAFT_CHARS",
  scope_tag: "OVERTURN_SCOPE_TAG",
  max_context_parts: "OVERTURN_MAX_CONTEXT_PARTS",
  decision_fields: "OVERTURN_DECISION_FIELDS",
  intercom_token: "INTERCOM_ACCESS_TOKEN",
  intercom_api_base: "INTERCOM_API_BASE",
};

function configFrom(env) {
  const config = {};
  for (const [key, name] of Object.entries(CONFIG_KEYS)) {
    if (env[name]) config[key] = env[name];
  }
  return config;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET") return json({ ok: true, service: "overturn-intercom-app" });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (url.pathname !== "/intercom/initialize" && url.pathname !== "/intercom/submit") {
      return json({ error: "not found" }, 404);
    }

    const rawBody = await request.text();
    if (env.INTERCOM_CLIENT_SECRET) {
      const ok = await validSignature(
        rawBody,
        request.headers.get("x-body-signature"),
        env.INTERCOM_CLIENT_SECRET,
      );
      if (!ok) return json({ error: "bad signature" }, 401);
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return json({ error: "bad json" }, 400);
    }

    try {
      return json(await handleCanvasRequest(payload, runtimeFrom(configFrom(env))));
    } catch (error) {
      return canvasSaying(`Overturn could not answer this request (${error?.message ?? "error"}).`);
    }
  },
};
