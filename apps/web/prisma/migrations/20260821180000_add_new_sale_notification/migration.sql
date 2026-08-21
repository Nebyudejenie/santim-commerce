-- IF NOT EXISTS: same reasoning as every other enum addition this
-- session — Postgres has no ALTER TYPE ... DROP VALUE, so this stays
-- safe to apply again if this migration is ever amended after a partial
-- apply.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'NEW_SALE';
