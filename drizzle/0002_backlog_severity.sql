-- Severity column on backlog items. Combined with category to auto-place
-- new items: bug+critical → top, bug+major → below criticals, etc.
-- See tools/ocean-bot/dashboard/src/lib/backlog-ops.ts#createBacklogItem.

ALTER TABLE "ocean_bot_backlog_item"
  ADD COLUMN IF NOT EXISTS "severity" text NOT NULL DEFAULT 'unspecified';
