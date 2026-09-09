-- Records *why* a refresh token was revoked, so that a normal logout can be
-- told from a replay after rotation (T-050).
--
-- Expand only, per Plan §12.3. Both halves are safe for release N-1:
--
--   * the column is nullable with no default, so N-1's `UPDATE refresh_tokens
--     SET revoked_at = …` — which never mentions it — keeps working, and its
--     rows simply carry NULL;
--   * NULL reads as 'rotated' in the application, which is exactly what N-1's
--     rows mean and exactly how every row revoked before this migration was
--     already treated. The upgrade therefore changes nothing for existing data.
--
-- The pairing invariant `(revoked_at IS NULL) = (revoked_reason IS NULL)` is
-- deliberately NOT added here. It would reject release N-1's writes. It is a
-- contract step for a later release, after a backfill, and belongs with the
-- change that stops reading NULL as 'rotated'.
ALTER TABLE "refresh_tokens" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
-- `NOT VALID` then `VALIDATE`, rather than the one validating statement
-- drizzle-kit generates: the plain form holds ACCESS EXCLUSIVE for the whole
-- table scan, which blocks readers, and `scripts/lint-migrations.mjs` rejects
-- it. `NOT VALID` takes that lock only briefly and applies to new rows;
-- `VALIDATE CONSTRAINT` then scans under SHARE UPDATE EXCLUSIVE, which lets
-- writers through. The scan finds nothing to complain about — every existing
-- row has NULL here, which the constraint admits.
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_revoked_reason_valid" CHECK ("refresh_tokens"."revoked_reason" is null or "refresh_tokens"."revoked_reason" in ('rotated', 'logout', 'reuse_detected')) NOT VALID;--> statement-breakpoint
ALTER TABLE "refresh_tokens" VALIDATE CONSTRAINT "refresh_tokens_revoked_reason_valid";
