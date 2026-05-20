import type { Config } from "drizzle-kit";

// The dashboard ONLY needs Auth.js tables migrated. The ocean_bot_*
// tables are owned by the bot's schema (tools/ocean-bot/drizzle/).
// We point at a slim auth-only schema to avoid generating duplicate
// migrations for the ocean_bot_* tables.

export default {
  schema: "./src/lib/db/auth-schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["OCEAN_BOT_DATABASE_URL"] ?? "postgres://invalid",
  },
} satisfies Config;
