CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_id_project_id_key" UNIQUE("id","project_id"),
	CONSTRAINT "conversations_id_format" CHECK ("conversations"."id" ~ '^cnv_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "conversations_project_id_format" CHECK ("conversations"."project_id" ~ '^prj_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"message_id" text NOT NULL,
	"session_id" text NOT NULL,
	"delivered_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"acked_at" timestamp (3) with time zone,
	CONSTRAINT "deliveries_message_id_session_id_pk" PRIMARY KEY("message_id","session_id"),
	CONSTRAINT "deliveries_message_id_format" CHECK ("deliveries"."message_id" ~ '^msg_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "deliveries_session_id_format" CHECK ("deliveries"."session_id" ~ '^ses_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machines_user_id_name_key" UNIQUE("user_id","name"),
	CONSTRAINT "machines_id_format" CHECK ("machines"."id" ~ '^mch_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "machines_user_id_format" CHECK ("machines"."user_id" ~ '^usr_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "machines_name_present" CHECK (char_length("machines"."name") > 0 and char_length("machines"."name") <= 255)
);
--> statement-breakpoint
CREATE TABLE "message_inbox" (
	"message_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"acked_at" timestamp (3) with time zone,
	"acked_by_session_id" text,
	CONSTRAINT "message_inbox_message_id_agent_id_pk" PRIMARY KEY("message_id","agent_id"),
	CONSTRAINT "message_inbox_message_id_format" CHECK ("message_inbox"."message_id" ~ '^msg_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "message_inbox_agent_id_format" CHECK ("message_inbox"."agent_id" ~ '^agt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "message_inbox_project_id_format" CHECK ("message_inbox"."project_id" ~ '^prj_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "message_inbox_acked_by_session_id_format" CHECK ("message_inbox"."acked_by_session_id" is null or "message_inbox"."acked_by_session_id" ~ '^ses_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "message_inbox_status_valid" CHECK ("message_inbox"."status" in ('pending', 'acked')),
	CONSTRAINT "message_inbox_acked_at_matches_status" CHECK (("message_inbox"."status" = 'acked') = ("message_inbox"."acked_at" is not null)),
	CONSTRAINT "message_inbox_acked_by_requires_ack" CHECK ("message_inbox"."acked_by_session_id" is null or "message_inbox"."status" = 'acked')
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"parent_message_id" text,
	"sender_agent_id" text NOT NULL,
	"recipient_agent_id" text NOT NULL,
	"content" text NOT NULL,
	"client_message_id" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_sender_agent_id_client_message_id_key" UNIQUE("sender_agent_id","client_message_id"),
	CONSTRAINT "messages_id_format" CHECK ("messages"."id" ~ '^msg_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "messages_project_id_format" CHECK ("messages"."project_id" ~ '^prj_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "messages_conversation_id_format" CHECK ("messages"."conversation_id" ~ '^cnv_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "messages_sender_agent_id_format" CHECK ("messages"."sender_agent_id" ~ '^agt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "messages_recipient_agent_id_format" CHECK ("messages"."recipient_agent_id" ~ '^agt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "messages_parent_message_id_format" CHECK ("messages"."parent_message_id" is null or "messages"."parent_message_id" ~ '^msg_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "messages_content_within_limit" CHECK (octet_length("messages"."content") <= 1048576),
	CONSTRAINT "messages_client_message_id_present" CHECK (char_length("messages"."client_message_id") > 0 and char_length("messages"."client_message_id") <= 200)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"project_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"runtime" text,
	"working_directory" text NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp (3) with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "sessions_id_format" CHECK ("sessions"."id" ~ '^ses_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "sessions_agent_id_format" CHECK ("sessions"."agent_id" ~ '^agt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "sessions_project_id_format" CHECK ("sessions"."project_id" ~ '^prj_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "sessions_machine_id_format" CHECK ("sessions"."machine_id" ~ '^mch_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "sessions_status_valid" CHECK ("sessions"."status" in ('active', 'stale', 'ended')),
	CONSTRAINT "sessions_ended_at_matches_status" CHECK (("sessions"."status" = 'ended') = ("sessions"."ended_at" is not null)),
	CONSTRAINT "sessions_runtime_present_if_set" CHECK ("sessions"."runtime" is null or (char_length("sessions"."runtime") > 0 and char_length("sessions"."runtime") <= 64)),
	CONSTRAINT "sessions_working_directory_present" CHECK (char_length("sessions"."working_directory") > 0 and char_length("sessions"."working_directory") <= 4096)
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "message_inbox" ADD CONSTRAINT "message_inbox_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "message_inbox" ADD CONSTRAINT "message_inbox_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "message_inbox" ADD CONSTRAINT "message_inbox_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "message_inbox" ADD CONSTRAINT "message_inbox_acked_by_session_id_sessions_id_fk" FOREIGN KEY ("acked_by_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_message_id_messages_id_fk" FOREIGN KEY ("parent_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_agent_id_agents_id_fk" FOREIGN KEY ("sender_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_recipient_agent_id_agents_id_fk" FOREIGN KEY ("recipient_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_project_id_fk" FOREIGN KEY ("conversation_id","project_id") REFERENCES "public"."conversations"("id","project_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "conversations_project_id_idx" ON "conversations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "message_inbox_pending_idx" ON "message_inbox" USING btree ("agent_id","project_id","message_id") WHERE "message_inbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_recipient_agent_id_project_id_created_at_idx" ON "messages" USING btree ("recipient_agent_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_project_agent_active_idx" ON "sessions" USING btree ("project_id","agent_id") WHERE "sessions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "sessions_agent_id_idx" ON "sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "sessions_stale_sweep_idx" ON "sessions" USING btree ("last_seen_at") WHERE "sessions"."status" = 'active';--> statement-breakpoint
-- The debt T-101 recorded, now payable.
--
-- `refresh_tokens.machine_id` shipped in 0000_identity with a format `CHECK` and
-- no foreign key, because `machines` did not exist yet: the expand half of Plan
-- §12.3, a nullable column holding nothing until there was something to point
-- at. `machines` exists as of this migration, so the constraint goes on here.
--
-- `ON DELETE SET NULL`, deliberately. A machine row is diagnostics — which
-- laptop holds this credential — and losing it must cost the diagnostic, not the
-- session. A cascade here would log somebody out of every machine to tidy up a
-- record of one, and `RESTRICT` would make a machine undeletable for ninety days
-- after its last login.
--
-- Written by hand rather than generated, because `server/src/db/schema/
-- identity.ts` belongs to a finished task (T-101) and T-301 does not own it. The
-- consequence is that drizzle-kit's snapshot does not know this constraint
-- exists: `drizzle-kit generate` still reports no drift, because it diffs the
-- schema files against its own snapshot and neither mentions the key, but the
-- model and the database now disagree by exactly this one constraint. The name
-- is therefore *precisely* the one drizzle would have chosen —
-- `refresh_tokens_machine_id_machines_id_fk` — so that whoever next owns
-- `identity.ts` can add `.references(() => machines.id, { onDelete: 'set null',
-- onUpdate: 'cascade' })` to `machineId`, record the key in the snapshot, and
-- emit no SQL at all. Filed for T-302..T-308 in the pull request.
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE cascade;
