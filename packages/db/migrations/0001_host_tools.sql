ALTER TABLE "nibblets" ADD COLUMN "host_tools" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "nibblets" ADD COLUMN "cli_credentials" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "nibblets" ADD COLUMN "mcp_servers" jsonb DEFAULT '[]'::jsonb NOT NULL;