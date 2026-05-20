// Slim Auth.js-only schema, used by drizzle-kit when generating the
// dashboard's migrations. The full read-mirror schema is in schema.ts;
// keep these two files in sync for the auth tables.

export {
  users,
  accounts,
  sessions,
  verificationTokens,
} from "./schema";
