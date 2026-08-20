-- Per-account AI receptionist photo, uploaded by the account owner from
-- Account Settings. Until now the greeting banner and onboarding persona could
-- only show the PLATFORM-wide branding avatar (admin-uploaded, one per voice
-- gender) or a built-in stock headshot, so every customer's assistant wore the
-- same face.
--
-- Two columns, not one: `Url` is what clients render, `Key` is the S3 object
-- key. Without the key a replaced photo would be orphaned in the bucket forever,
-- because the public URL alone can't be mapped back to an object reliably.
--
-- Defaults to '' rather than NULL to match every other optional string on this
-- table, so read paths keep using `if (!value)` and never need a null check.
--
-- No backfill: an empty string is exactly right for existing rows — it means
-- "fall through to the platform branding avatar", which is what they show today.
-- Idempotent (see server/MIGRATIONS.md).
ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "assistantAvatarUrl" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "assistantAvatarKey" TEXT NOT NULL DEFAULT '';
