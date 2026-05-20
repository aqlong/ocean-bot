import {
  pgTable,
  text,
  timestamp,
  bigint,
  bigserial,
  jsonb,
  integer,
  index,
} from "drizzle-orm/pg-core";

// ============================================================================
// Ocean-bot schema, separate Neon DB from apps/dashboard.
// All tables prefixed `ocean_bot_*` so a future merge with apps/dashboard
// can happen without rename collisions, though the v1 plan is to keep
// this DB isolated.
// ============================================================================

export const oceanBotRun = pgTable("ocean_bot_run", {
  id: text("id").primaryKey(), // ulid
  project: text("project").notNull(), // 'code2wiki' | 'cas' | 'inference-audit'
  queue: text("queue").notNull(), // 'gap-closure' | 'roadmap' | ...
  taskSummary: text("task_summary").notNull(),
  status: text("status").notNull(), // queued|running|awaiting-approval|approved|rejected|shipped|failed|reverted
  approvalMode: text("approval_mode").notNull(), // manual|auto|auto-with-visual
  branch: text("branch"),
  commitSha: text("commit_sha"),
  pushState: text("push_state"), // local|pushed|reverted
  dangerLevel: text("danger_level"), // safe|caution|super-dangerous
  dangerReasons: jsonb("danger_reasons"), // string[] when super-dangerous
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  blocker: text("blocker"),
  userDecision: text("user_decision"), // ship|skip|block
  userDecisionAt: timestamp("user_decision_at", { withTimezone: true }),
  metadata: jsonb("metadata"), // free-form: leverage score, est tokens, model, etc.
});

export const oceanBotEvent = pgTable(
  "ocean_bot_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => oceanBotRun.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    type: text("type").notNull(), // tool_use|tool_result|message|gate|visual|commit|push|error
    payload: jsonb("payload").notNull(),
  },
  (t) => ({
    runTsIdx: index("ocean_bot_event_run_ts_idx").on(t.runId, t.ts),
  }),
);

export const oceanBotUsage = pgTable(
  "ocean_bot_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id").references(() => oceanBotRun.id, {
      onDelete: "set null",
    }),
    source: text("source").notNull(), // ocean-bot|interactive|unknown
    project: text("project"), // optional attribution
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" })
      .notNull()
      .default(0),
    cacheRead: bigint("cache_read", { mode: "number" }).notNull().default(0),
    cacheWrite: bigint("cache_write", { mode: "number" }).notNull().default(0),
    model: text("model").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    observedIdx: index("ocean_bot_usage_observed_idx").on(t.observedAt),
    sourceObservedIdx: index("ocean_bot_usage_source_observed_idx").on(
      t.source,
      t.observedAt,
    ),
  }),
);

export const oceanBotState = pgTable("ocean_bot_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ============================================================================
// Backlog, user-curated work queue. Read by the bot's backlog queue source
// and edited via the dashboard's /backlog page.
//
// Distinct from ocean_bot_run: a run is a single bot-attempted unit of work;
// a backlog_item is a future intent. Items can become runs (bot picks them)
// or stay open indefinitely.
// ============================================================================

export const oceanBotBacklogItem = pgTable(
  "ocean_bot_backlog_item",
  {
    id: text("id").primaryKey(), // ulid
    project: text("project").notNull(),
    // Free-form category, but the dashboard UI exposes a fixed set:
    // bug | test | roadmap | refactor | docs | chore | feature | other
    category: text("category").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    // critical | major | minor | cosmetic | unspecified. Combined with
    // category to auto-place new items: bug+critical → top, bug+major →
    // below criticals, etc. See backlog-ops.ts#createBacklogItem.
    severity: text("severity").notNull().default("unspecified"),
    // Smaller integer = higher priority (drag-to-top sets to 1, etc.).
    // Reorders are bulk-rewrites of priority for affected rows.
    priority: integer("priority").notNull(),
    // open | in-progress | done | archived
    status: text("status").notNull().default("open"),
    // manual | auto:roadmap.md | auto:test-fail | auto:gap-closure | ...
    source: text("source").notNull().default("manual"),
    // File path / commit sha / etc., varies by source.
    sourceRef: text("source_ref"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectStatusPriorityIdx: index(
      "ocean_bot_backlog_project_status_priority_idx",
    ).on(t.project, t.status, t.priority),
    categoryIdx: index("ocean_bot_backlog_category_idx").on(t.category),
    createdAtIdx: index("ocean_bot_backlog_created_at_idx").on(t.createdAt),
  }),
);

export type OceanBotBacklogItem = typeof oceanBotBacklogItem.$inferSelect;
export type NewOceanBotBacklogItem = typeof oceanBotBacklogItem.$inferInsert;

export type OceanBotRun = typeof oceanBotRun.$inferSelect;
export type NewOceanBotRun = typeof oceanBotRun.$inferInsert;
export type OceanBotEvent = typeof oceanBotEvent.$inferSelect;
export type NewOceanBotEvent = typeof oceanBotEvent.$inferInsert;
export type OceanBotUsage = typeof oceanBotUsage.$inferSelect;
export type NewOceanBotUsage = typeof oceanBotUsage.$inferInsert;
export type OceanBotState = typeof oceanBotState.$inferSelect;
