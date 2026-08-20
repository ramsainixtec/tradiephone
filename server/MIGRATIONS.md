# Database migrations (Prisma)

This project's Prisma migration history is **not** in a clean `migrate deploy` state. This doc
explains the current situation, how to add a migration **today** (the workaround), and the one-time
**re-baseline** procedure to get back to a normal workflow.

> TL;DR for adding a migration right now: write the SQL, apply it idempotently with
> `prisma db execute`, then `prisma migrate resolve --applied <name>`. See
> [Adding a migration (current workflow)](#adding-a-migration-current-workflow).

---

## Why history is diverged

The shared Neon DB's `_prisma_migrations` table records **seven migrations whose SQL files exist in
no git branch**:

```
0001_baseline
0002_add_conversion_status_approval
0003_add_movermate_webhook_token
0004_admin_ops
0005_trial_fields
0006_onboarding_fields
0007_notifications
```

At some point these were **squashed into a single `0001_init` baseline** — that is what
`origin/main` carries today (`server/prisma/migrations/` has only `0001_init` +
`migration_lock.toml`). The old seven were never deleted from the DB, so they linger as "phantom"
rows. `0001_init` itself was applied to the already-populated DB via
`prisma migrate resolve --applied 0001_init` (you can see one failed/rolled-back row and one
applied-with-0-steps row for it in `_prisma_migrations`).

**Consequence:** the local `prisma/migrations` folder and the DB's recorded history don't line up,
so `prisma migrate deploy` / `migrate dev` will not cleanly auto-apply new migrations. The symptom
when a step is skipped is a runtime error like:

```
Invalid `prisma.subscriptionPlan.findMany()` invocation:
The column `subscription_plans.overagePerMinuteCents` does not exist in the current database.
```

(That exact error — the `0002_plan_tiers_overage` columns never being applied — is what prompted
this doc; fixed 2026-06-23.)

---

## Adding a migration (current workflow)

Until the re-baseline below is done, follow these steps for **every** schema change. Run from
`server/`.

1. **Edit `prisma/schema.prisma`** with your change.

2. **Create the migration SQL** without applying it (so the file is committed and ordered
   correctly):

   ```bash
   npx prisma migrate dev --create-only --name <descriptive_name>
   ```

   If `migrate dev` refuses because of the divergence, hand-write the folder instead:
   `prisma/migrations/<NNNN>_<descriptive_name>/migration.sql`.

3. **Make the SQL idempotent.** Use `IF NOT EXISTS` / `IF EXISTS` so re-running is safe and so it
   tolerates the DB being partially ahead:

   ```sql
   ALTER TABLE "subscription_plans"
     ADD COLUMN IF NOT EXISTS "overagePerMinuteCents" INTEGER NOT NULL DEFAULT 0;
   ```

4. **Apply the SQL to the DB:**

   ```bash
   npx prisma db execute --file prisma/migrations/<NNNN>_<name>/migration.sql --schema prisma/schema.prisma
   ```

5. **Record the migration as applied** (this writes the `_prisma_migrations` row without re-running
   the SQL — mirrors how `0001_init` was handled):

   ```bash
   npx prisma migrate resolve --applied <NNNN>_<name>
   ```

6. **Verify** — both must be clean:

   ```bash
   npx prisma migrate status                         # → "Database schema is up to date!"
   npx prisma migrate diff \
     --from-schema-datamodel prisma/schema.prisma \
     --to-schema-datasource prisma/schema.prisma \
     --exit-code                                      # → "No difference detected." (exit 0)
   ```

7. **Regenerate the client** if types changed: `npx prisma generate`.

8. **Commit** the `prisma/schema.prisma` change **and** the new `prisma/migrations/<NNNN>_<name>/`
   folder.

### Don't

- ❌ `prisma migrate reset` against the shared Neon DB — it drops and recreates everything.
- ❌ Manually `DELETE FROM _prisma_migrations` on the shared DB outside the re-baseline window.
- ❌ Rely on `migrate deploy` in CI to apply changes until the re-baseline is done.

---

## One-time re-baseline (the real fix)

Goal: make the DB's `_prisma_migrations` history match the repo so the normal
`migrate dev` / `migrate deploy` workflow works again. **Do this in a maintenance window** — it
touches the shared DB and should be coordinated so no one else is migrating at the same time.

### Prerequisites

- A **fresh DB backup / Neon branch snapshot** taken immediately before starting (Neon's branching
  makes this cheap — branch the DB and keep it as a rollback point).
- Agreement that the current `schema.prisma` on the chosen branch is the **intended** schema
  (the DB already physically matches it — `migrate diff` shows no drift).
- A quiet window: pause CI deploys and ask teammates to hold migrations.

### Procedure

1. **Confirm zero drift** between schema and DB (the whole approach depends on this):

   ```bash
   npx prisma migrate diff \
     --from-schema-datamodel prisma/schema.prisma \
     --to-schema-datasource prisma/schema.prisma \
     --exit-code
   ```

   Must print "No difference detected." If it doesn't, stop and reconcile the drift first.

2. **Generate one clean baseline migration** from the current schema. Start from an empty
   migrations folder on a working branch:

   ```bash
   rm -rf prisma/migrations
   mkdir -p prisma/migrations/0001_init
   npx prisma migrate diff \
     --from-empty \
     --to-schema-datamodel prisma/schema.prisma \
     --script > prisma/migrations/0001_init/migration.sql
   ```

   Keep `prisma/migrations/migration_lock.toml` (provider = `postgresql`).

3. **Clear the old history rows** on the shared DB (this is the destructive step the backup
   protects). Remove the seven phantom rows **and** the duplicate `0001_init` rows:

   ```sql
   DELETE FROM "_prisma_migrations";
   ```

   (Deleting all rows is simplest since we're about to re-stamp a single baseline. The schema
   objects themselves are untouched — only the bookkeeping table is cleared.)

4. **Stamp the new baseline as already applied** (the DB already has every object in it):

   ```bash
   npx prisma migrate resolve --applied 0001_init
   ```

5. **Verify clean:**

   ```bash
   npx prisma migrate status      # → only 0001_init, "Database schema is up to date!"
   ```

6. **Commit** the regenerated `prisma/migrations/0001_init/` to the branch, merge to `main`, and
   tell the team to delete their local `prisma/migrations` and pull.

7. **From here on**, the normal workflow returns:

   ```bash
   npx prisma migrate dev --name <change>     # local: creates + applies
   npx prisma migrate deploy                  # CI/prod: applies pending
   ```

### Rollback

If anything looks wrong after step 3–5, restore from the pre-start Neon branch snapshot. Because
steps 1–2 only touch local files and step 3 only clears a bookkeeping table, the blast radius is
small — but the snapshot is the safety net.

---

## Quick reference

| Situation | Command |
|---|---|
| Apply a SQL file to the DB | `npx prisma db execute --file <path> --schema prisma/schema.prisma` |
| Record a migration as applied (no SQL run) | `npx prisma migrate resolve --applied <name>` |
| Is the DB in sync? | `npx prisma migrate status` |
| Drift between schema and DB? | `npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma --exit-code` |
| Inspect recorded migrations | `SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY started_at;` |
