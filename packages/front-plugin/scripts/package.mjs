// Assembles the hostable Front plugin: page + styles + the built script, then zips it.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "dist", "app");
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "assets"), { recursive: true });
cpSync(path.join(root, "app"), out, { recursive: true });
cpSync(path.join(root, "dist", "main.global.js"), path.join(out, "assets", "main.js"));

// Front loads a plugin from a URL, so the zip is what you drop on any static host (or behind
// your own), and the plugin URL in the developer app points at its index.html.
const zip = path.join(root, "dist", "overturn-front-plugin.zip");
try {
  rmSync(zip, { force: true });
  execFileSync("zip", ["-qr", zip, "."], { cwd: out });
  console.log("dist/overturn-front-plugin.zip");
} catch {
  console.log("dist/app (zip not available; host the folder as it is)");
}
