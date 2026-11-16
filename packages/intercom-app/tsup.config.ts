import { defineConfig } from "tsup";

// Two self-contained builds from one source: ESM for the worker and Node entries, IIFE for a host
// that can only load a plain script. No module loader, no externals in either.
export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["esm", "iife"],
  globalName: "OverturnIntercom",
  platform: "browser",
  target: "es2020",
  sourcemap: false,
  clean: true,
  minify: true,
  noExternal: ["@overturn-ai/shared"],
  outExtension: ({ format }) => ({ js: format === "iife" ? ".global.js" : ".mjs" }),
  outDir: "dist",
});
