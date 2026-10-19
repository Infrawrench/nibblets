CREATE TABLE "cards" (
	"id" text PRIMARY KEY NOT NULL,
	"nibblet_id" text NOT NULL,
	"provider" text NOT NULL,
	"ref" text NOT NULL,
	"asset" text NOT NULL,
	"decimals" integer NOT NULL,
	"kind" text NOT NULL,
	"limit_minor" numeric(78, 0) NOT NULL,
	"spent_minor" numeric(78, 0) DEFAULT '0' NOT NULL,
	"purpose" text NOT NULL,
	"display" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"closed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "nibblets" ADD COLUMN "spending_limits" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_nibblet_id_nibblets_id_fk" FOREIGN KEY ("nibblet_id") REFERENCES "public"."nibblets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_nibblet_idx" ON "cards" USING btree ("nibblet_id","created_at");--> statement-breakpoint
CREATE INDEX "cards_state_idx" ON "cards" USING btree ("state");