ALTER TABLE "auth_user" ADD COLUMN "username" text;
--> statement-breakpoint
-- Preserve account IDs and credentials. Prefer existing login local parts;
-- duplicate/invalid names receive a deterministic ID-derived username.
WITH candidates AS (
  SELECT id, lower(split_part(email, '@', 1)) AS candidate,
    row_number() OVER (
      PARTITION BY lower(split_part(email, '@', 1))
      ORDER BY (lower(email) IN ('admin@tasklattice.local', 'user@tasklattice.local')) DESC, created_at, id
    ) AS ordinal
  FROM "auth_user"
)
UPDATE "auth_user" AS target SET username = CASE
  WHEN candidate ~ '^[a-z0-9_.-]{3,64}$' AND ordinal = 1
    AND left(candidate, 8) <> 'account_' THEN candidate
  ELSE 'account_' || md5(target.id)
END FROM candidates WHERE target.id = candidates.id;
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_user_username_unique" ON "auth_user" ("username");
