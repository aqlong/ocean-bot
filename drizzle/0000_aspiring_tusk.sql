CREATE TABLE "ocean_bot_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocean_bot_run" (
	"id" text PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"queue" text NOT NULL,
	"task_summary" text NOT NULL,
	"status" text NOT NULL,
	"approval_mode" text NOT NULL,
	"branch" text,
	"commit_sha" text,
	"push_state" text,
	"danger_level" text,
	"danger_reasons" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"blocker" text,
	"user_decision" text,
	"user_decision_at" timestamp with time zone,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "ocean_bot_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ocean_bot_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text,
	"source" text NOT NULL,
	"project" text,
	"window_start" timestamp with time zone NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read" bigint DEFAULT 0 NOT NULL,
	"cache_write" bigint DEFAULT 0 NOT NULL,
	"model" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ocean_bot_event" ADD CONSTRAINT "ocean_bot_event_run_id_ocean_bot_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ocean_bot_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ocean_bot_usage" ADD CONSTRAINT "ocean_bot_usage_run_id_ocean_bot_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ocean_bot_run"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ocean_bot_event_run_ts_idx" ON "ocean_bot_event" USING btree ("run_id","ts");--> statement-breakpoint
CREATE INDEX "ocean_bot_usage_observed_idx" ON "ocean_bot_usage" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "ocean_bot_usage_source_observed_idx" ON "ocean_bot_usage" USING btree ("source","observed_at");