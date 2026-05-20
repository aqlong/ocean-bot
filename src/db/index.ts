import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const url = process.env["OCEAN_BOT_DATABASE_URL"];
  if (!url) {
    throw new Error(
      "OCEAN_BOT_DATABASE_URL is not set. See tools/ocean-bot/README.md.",
    );
  }
  pool = new Pool({ connectionString: url });
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export { schema };
