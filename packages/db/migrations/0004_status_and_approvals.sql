ALTER TABLE "nibblets" ADD COLUMN "tool_approvals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "nibblets" ADD COLUMN "status_text" text;--> statement-breakpoint
ALTER TABLE "nibblets" ADD COLUMN "status_emoji" text;--> statement-breakpoint
ALTER TABLE "nibblets" ADD COLUMN "status_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nibblets" ADD COLUMN "awaiting_approval" boolean DEFAULT false NOT NULL;