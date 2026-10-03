import { defineConfig } from "vitest/config";

// The core tests talk to the real database. Same variables as the app, never printed.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No local env file: DATABASE_URL must already be set.
}

export default defineConfig({
  test: {
    include: ["core/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
