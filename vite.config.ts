import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import vinext from "vinext";
import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

async function localBindingConfig() {
  let hostingConfig: { d1?: string | null; r2?: string | null };
  try {
    hostingConfig = JSON.parse(
      await readFile(resolve(process.cwd(), ".openai/hosting.json"), "utf8"),
    ) as { d1?: string | null; r2?: string | null };
  } catch {
    throw new Error("Sites builds require .openai/hosting.json.");
  }
  const { d1, r2 } = hostingConfig;
  return {
    main: "./worker/index.ts",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: d1
      ? [
          {
            binding: d1,
            database_name: "site-creator-d1",
            database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
          },
        ]
      : [],
    r2_buckets: r2
      ? [
          {
            binding: r2,
            bucket_name: "site-creator-r2",
          },
        ]
      : [],
  };
}

export default defineConfig(async () => {
  const server = isCodexSeatbeltSandbox
    ? { watch: { useFsEvents: false, usePolling: true } }
    : undefined;

  // The product runs on Node (locally and on DigitalOcean) because its SSRF
  // defense pins validated DNS answers at the socket layer. Sites is a separate
  // private preview target whose Workers runtime does not execute that crawler.
  if (process.env.THREADLINE_BUILD_TARGET !== "sites") {
    return { server, plugins: [vinext()] };
  }

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: await localBindingConfig(),
      }),
    ],
  };
});
