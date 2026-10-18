CREATE TABLE "client_submissions" (
	"nibblet_id" text NOT NULL,
	"client_message_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"user_item_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_submissions_nibblet_id_client_message_id_pk" PRIMARY KEY("nibblet_id","client_message_id")
);
--> statement-breakpoint
ALTER TABLE "client_submissions" ADD CONSTRAINT "client_submissions_nibblet_id_nibblets_id_fk" FOREIGN KEY ("nibblet_id") REFERENCES "public"."nibblets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "client_submissions_turn_idx" ON "client_submissions" USING btree ("nibblet_id","turn_id");