CREATE TABLE "app_links" (
	"id" text PRIMARY KEY NOT NULL,
	"plugin" text NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ref" text NOT NULL,
	"secret" text NOT NULL,
	"account" text NOT NULL,
	"state" text DEFAULT 'linked' NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_links_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "nibblet_app_grants" (
	"nibblet_id" text NOT NULL,
	"link_id" text NOT NULL,
	"ref" text NOT NULL,
	"secret" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"providers" text[] DEFAULT '{}' NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nibblet_app_grants_nibblet_id_link_id_pk" PRIMARY KEY("nibblet_id","link_id")
);
--> statement-breakpoint
ALTER TABLE "nibblet_app_grants" ADD CONSTRAINT "nibblet_app_grants_link_id_app_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."app_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nibblet_app_grants_link_idx" ON "nibblet_app_grants" USING btree ("link_id");