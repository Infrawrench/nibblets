-- Where a link was started from, so approving a link from somewhere else
-- (one someone sent you) comes with a warning and an extra step.
ALTER TABLE link_requests ADD COLUMN ip TEXT;
ALTER TABLE link_requests ADD COLUMN location TEXT;
