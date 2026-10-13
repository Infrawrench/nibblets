ALTER TABLE "nibblets" ALTER COLUMN "heartbeat" SET DEFAULT '[]'::jsonb;--> statement-breakpoint
-- A nibblet's single heartbeat becomes a list. An enabled one is kept as
-- "check-in", with its interval, hours and prompt; a disabled one goes.
UPDATE "nibblets" SET "heartbeat" = CASE
  WHEN jsonb_typeof("heartbeat") = 'array' THEN "heartbeat"
  WHEN ("heartbeat"->>'enabled')::boolean THEN jsonb_build_array(jsonb_build_object(
    'name', 'check-in',
    'everyMinutes', GREATEST(5, ("heartbeat"->>'everyMinutes')::int),
    'activeHours', "heartbeat"->'activeHours',
    'checklist', COALESCE("heartbeat"->>'prompt', ''),
    'lastRunAt', to_jsonb(to_char("last_heartbeat_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  ))
  ELSE '[]'::jsonb
END;--> statement-breakpoint
ALTER TABLE "nibblets" DROP COLUMN "last_heartbeat_at";
