-- Photo for the ACCOUNT OWNER, uploaded from Account Settings. Until now the
-- only per-account image was `assistantAvatarUrl` — the AI receptionist's face —
-- so the dashboard greeting banner ("Welcome back, <name>") showed the
-- assistant's stock headshot next to the owner's own name.
--
-- No default image is stored: an account with no upload renders a monogram of
-- its first/last name on the client (see initialsFor() / <UserAvatar>). That
-- needs no storage, no request, and re-derives itself when the name changes,
-- which a generated PNG would not.
--
-- Two columns, not one: `Url` is what clients render, `Key` is the S3 object key.
-- Without the key a replaced photo would be orphaned in the bucket forever,
-- because the public URL alone can't be mapped back to an object reliably.
--
-- Defaults to '' rather than NULL to match every other optional string on this
-- table, so read paths keep using `if (!value)` and never need a null check.
--
-- No backfill: an empty string is exactly right for existing rows — it means
-- "render the name monogram", which is the intended default for every account.
-- Idempotent (see server/MIGRATIONS.md).
ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "profileAvatarUrl" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "profileAvatarKey" TEXT NOT NULL DEFAULT '';
