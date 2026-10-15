CREATE TABLE "payment_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"credentials" jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"nibblet_id" text NOT NULL,
	"account_id" text,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"purpose" text NOT NULL,
	"source" text NOT NULL,
	"last_four" text NOT NULL,
	"limit_cents" bigint NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"closed_reason" text,
	"file_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"first_charge_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payment_charges" (
	"card_id" text NOT NULL,
	"ref" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_charges_card_id_ref_pk" PRIMARY KEY("card_id","ref")
);
--> statement-breakpoint
ALTER TABLE "nibblets" ADD COLUMN "payments" jsonb DEFAULT '{"limitCents":0,"period":"monthly","access":{}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_cards" ADD CONSTRAINT "payment_cards_nibblet_id_nibblets_id_fk" FOREIGN KEY ("nibblet_id") REFERENCES "public"."nibblets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_cards" ADD CONSTRAINT "payment_cards_account_id_payment_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."payment_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_charges" ADD CONSTRAINT "payment_charges_card_id_payment_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."payment_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_cards_nibblet_idx" ON "payment_cards" USING btree ("nibblet_id");--> statement-breakpoint
CREATE INDEX "payment_cards_ref_idx" ON "payment_cards" USING btree ("provider","provider_ref");