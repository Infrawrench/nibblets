CREATE TABLE "app_views" (
	"nibblet_id" text NOT NULL,
	"id" text NOT NULL,
	"html" text NOT NULL,
	"csp" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prefers_border" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_views_nibblet_id_id_pk" PRIMARY KEY("nibblet_id","id")
);
--> statement-breakpoint
ALTER TABLE "app_views" ADD CONSTRAINT "app_views_nibblet_id_nibblets_id_fk" FOREIGN KEY ("nibblet_id") REFERENCES "public"."nibblets"("id") ON DELETE cascade ON UPDATE no action;