-- Rename auth columns + tables from snake_case to camelCase so
-- @auth/drizzle-adapter's generated SQL matches the DB. The adapter
-- ignores Drizzle's column-name mapping and uses JS property names
-- directly. See dashboard/src/lib/db/schema.ts for the canonical form.

ALTER TABLE "user" RENAME COLUMN "email_verified" TO "emailVerified";
-- Drop the unused created_at — Auth.js's canonical schema doesn't include it.
ALTER TABLE "user" DROP COLUMN IF EXISTS "created_at";

ALTER TABLE "account" RENAME COLUMN "user_id" TO "userId";
ALTER TABLE "account" RENAME COLUMN "provider_account_id" TO "providerAccountId";

ALTER TABLE "session" RENAME COLUMN "session_token" TO "sessionToken";
ALTER TABLE "session" RENAME COLUMN "user_id" TO "userId";

-- Rename the table itself for verification_token → verificationToken.
ALTER TABLE "verification_token" RENAME TO "verificationToken";
