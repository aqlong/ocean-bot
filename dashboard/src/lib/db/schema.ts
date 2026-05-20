// Schema mirror. Source of truth lives at tools/ocean-bot/src/db/schema.ts;
// the bot owns writes, the dashboard is read-only against these tables
// (plus the auth tables added below). Keep in sync if the bot's schema
// changes, typecheck + read queries will fail loudly when out of sync.

import {
  pgTable,
  text,
  timestamp,
  bigint,
  bigserial,
  jsonb,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

export const oceanBotRun = pgTable("ocean_bot_run", {
  id: text("id").primaryKey(),
  project: text("project").notNull(),
  queue: text("queue").notNull(),
  taskSummary: text("task_summary").notNull(),
  status: text("status").notNull(),
  approvalMode: text("approval_mode").notNull(),
  branch: text("branch"),
  commitSha: text("commit_sha"),
  pushState: text("push_state"),
  dangerLevel: text("danger_level"),
  dangerReasons: jsonb("danger_reasons"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  blocker: text("blocker"),
  userDecision: text("user_decision"),
  userDecisionAt: timestamp("user_decision_at", { withTimezone: true }),
  metadata: jsonb("metadata"),
});

export const oceanBotEvent = pgTable(
  "ocean_bot_event",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => oceanBotRun.id, { onDelete: "cascade" }),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    type: text("type").notNull(),
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
    source: text("source").notNull(),
    project: text("project"),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
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

// Mirror of tools/ocean-bot/src/db/schema.ts → oceanBotBacklogItem.
// User-curated backlog; the dashboard owns reads + writes here.

export const oceanBotBacklogItem = pgTable(
  "ocean_bot_backlog_item",
  {
    id: text("id").primaryKey(),
    project: text("project").notNull(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    severity: text("severity").notNull().default("unspecified"),
    priority: integer("priority").notNull(),
    status: text("status").notNull().default("open"),
    source: text("source").notNull().default("manual"),
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

// ------------------------- Auth.js tables -------------------------------
// IMPORTANT: column names below match Auth.js's canonical Drizzle schema
// EXACTLY (camelCase, not snake_case). @auth/drizzle-adapter generates
// SQL using the JS property names, if the DB column name differs, every
// query fails with "column does not exist." Don't "normalize" these to
// snake_case. https://authjs.dev/getting-started/adapters/drizzle

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
});

export const accounts = pgTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (a) => ({ pk: primaryKey({ columns: [a.provider, a.providerAccountId] }) }),
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (vt) => ({ pk: primaryKey({ columns: [vt.identifier, vt.token] }) }),
);
