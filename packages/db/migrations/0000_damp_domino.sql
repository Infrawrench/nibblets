CREATE SEQUENCE "public"."item_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "auth_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"nibblet_id" text NOT NULL,
	"item_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"item" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_nibblet_id_item_id_pk" PRIMARY KEY("nibblet_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"nibblet_id" text,
	"kind" text DEFAULT 'note' NOT NULL,
	"content" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"embedding" vector(384) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nibblets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"look" jsonb NOT NULL,
	"harness" text NOT NULL,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"parent_id" text,
	"status" text DEFAULT 'stopped' NOT NULL,
	"status_detail" text,
	"heartbeat" jsonb NOT NULL,
	"browser" boolean DEFAULT true NOT NULL,
	"token_hash" text NOT NULL,
	"container_id" text,
	"harness_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "peers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"nibblet_id" text NOT NULL,
	"name" text NOT NULL,
	"cron" text,
	"run_at" timestamp with time zone,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"prompt" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_nibblet_id_nibblets_id_fk" FOREIGN KEY ("nibblet_id") REFERENCES "public"."nibblets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_nibblet_id_nibblets_id_fk" FOREIGN KEY ("nibblet_id") REFERENCES "public"."nibblets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_nibblet_id_nibblets_id_fk" FOREIGN KEY ("nibblet_id") REFERENCES "public"."nibblets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_seq_idx" ON "items" USING btree ("nibblet_id","seq");--> statement-breakpoint
CREATE INDEX "memories_embedding_idx" ON "memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memories_nibblet_idx" ON "memories" USING btree ("nibblet_id","kind");