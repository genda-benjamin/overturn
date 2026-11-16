// Assembles the deployable Intercom app: the Canvas Kit webhook bundle, the worker and server
// entries, and a config template. Intercom has no upload step (no manifest, no app package), so
// what ships here is what you deploy, and the zip is the whole thing in one file.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "assets"), { recursive: true });
cpSync(path.join(root, "app"), out, { recursive: true });

// The bundle, in both shapes the templates use: ESM for the worker and the Node server,
// IIFE for a host that can only load a plain script.
const esm = path.join(root, "dist", "main.mjs");
const iife = path.join(root, "dist", "main.global.js");
if (!existsSync(esm) || !existsSync(iife)) {
  console.error("dist/main.mjs and dist/main.global.js are missing: run tsup first");
  process.exit(1);
}
cpSync(esm, path.join(out, "assets", "main.mjs"));
cpSync(iife, path.join(out, "assets", "main.js"));

// config.json is what the Node server reads; it is gitignored because it holds two secrets.
// Nothing is written when the environment already carries them (a worker's secrets do that).
const config = path.join(out, "config.json");
const env = process.env;
if (env.OVERTURN_API_KEY) {
  writeFileSync(
    config,
    `${JSON.stringify(
      Object.fromEntries(
        Object.entries({
          overturn_api_key: env.OVERTURN_API_KEY,
          overturn_base_url: env.OVERTURN_BASE_URL,
          agent: env.OVERTURN_AGENT,
          reason_pack: env.OVERTURN_REASON_PACK,
          require_reason: env.OVERTURN_REQUIRE_REASON,
          capture_notes: env.OVERTURN_CAPTURE_NOTES,
          min_draft_chars: env.OVERTURN_MIN_DRAFT_CHARS,
          scope_tag: env.OVERTURN_SCOPE_TAG,
          max_context_parts: env.OVERTURN_MAX_CONTEXT_PARTS,
          decision_fields: env.OVERTURN_DECISION_FIELDS,
          intercom_token: env.INTERCOM_ACCESS_TOKEN,
          intercom_api_base: env.INTERCOM_API_BASE,
        }).filter(([, v]) => v !== undefined),
      ),
      null,
      2,
    )}\n`,
  );
  console.log("dist/app/config.json (from the environment; keep it out of git)");
}

// The installer pastes these two into Developer Hub → Configure → Canvas Kit → For teammates.
const base = (env.OVERTURN_APP_URL ?? "https://<your-host>").replace(/\/+$/, "");
console.log(`Initialize flow webhook URL: ${base}/intercom/initialize`);
console.log(`Submit flow webhook URL:     ${base}/intercom/submit`);

const zip = (name) => {
  try {
    rmSync(path.join(root, "dist", name), { force: true });
    execFileSync("zip", ["-qr", path.join(root, "dist", name), "."], { cwd: out });
    console.log(`dist/${name}`);
  } catch {
    console.log("dist/app (zip not available; deploy the folder)");
  }
};
zip("overturn-intercom-app.zip");
