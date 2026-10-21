ALTER TABLE "nibblets" ADD COLUMN "prompt_name" text;--> statement-breakpoint
ALTER TABLE "nibblets" ADD COLUMN "plain" boolean DEFAULT false NOT NULL;