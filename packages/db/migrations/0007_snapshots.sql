CREATE TABLE "snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"nibblet_id" text NOT NULL,
	"label" text,
	"trigger" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"message_count" integer NOT NULL,
	"max_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nibblets" ADD COLUMN "snapshot_policy" jsonb DEFAULT '{"everyMinutes":1440,"keep":7}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_nibblet_id_nibblets_id_fk" FOREIGN KEY ("nibblet_id") REFERENCES "public"."nibblets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "snapshots_nibblet_idx" ON "snapshots" USING btree ("nibblet_id","created_at");