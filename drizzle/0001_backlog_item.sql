-- User-curated backlog feeding the bot's new backlog queue source +
-- the dashboard's /backlog page.

CREATE TABLE IF NOT EXISTS "ocean_bot_backlog_item" (
  "id" text PRIMARY KEY NOT NULL,
  "project" text NOT NULL,
  "category" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "priority" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "source" text NOT NULL DEFAULT 'manual',
  "source_ref" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ocean_bot_backlog_project_status_priority_idx"
  ON "ocean_bot_backlog_item" ("project", "status", "priority");
CREATE INDEX IF NOT EXISTS "ocean_bot_backlog_category_idx"
  ON "ocean_bot_backlog_item" ("category");
CREATE INDEX IF NOT EXISTS "ocean_bot_backlog_created_at_idx"
  ON "ocean_bot_backlog_item" ("created_at");
