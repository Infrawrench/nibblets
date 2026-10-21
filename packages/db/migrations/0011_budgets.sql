CREATE TABLE "spend" (
	"nibblet_id" text NOT NULL,
	"month" text NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spend_nibblet_id_month_pk" PRIMARY KEY("nibblet_id","month")
);
--> statement-breakpoint
ALTER TABLE "nibblets" ADD COLUMN "monthly_budget_usd" double precision;--> statement-breakpoint
ALTER TABLE "spend" ADD CONSTRAINT "spend_nibblet_id_nibblets_id_fk" FOREIGN KEY ("nibblet_id") REFERENCES "public"."nibblets"("id") ON DELETE cascade ON UPDATE no action;