import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // Declare your Neon services here
  auth: true,
  functions: {
    hello: { name: "Hello World", source: "./hello.ts" },
    journal: {
      name: "Private options journal",
      source: "./server/index.mjs",
      env: {
        OWNER_EMAIL: { value: process.env.OWNER_EMAIL, required: true },
        JOURNAL_ALLOWED_ORIGINS: { value: process.env.JOURNAL_ALLOWED_ORIGINS, required: false, onUndefined: "skip" },
      },
    },
  },
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run `neon checkout <name>` to create a new branch with these settings
      return { ttl: "7d" };
    }
    // Existing branch: no changes
    return {};
  },
});
