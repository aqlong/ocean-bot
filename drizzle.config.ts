import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["OCEAN_BOT_DATABASE_URL"] ?? "postgres://invalid",
  },
} satisfies Config;
