import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // Exclude tools tests - they use Node.js APIs (shescape, Bun.spawn) and must run
    // outside the Workers pool. Run them separately with: bun test test/tools/
    exclude: ["**/node_modules/**", "**/test/tools/**"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.test.jsonc" },
      },
    },
  },
});
