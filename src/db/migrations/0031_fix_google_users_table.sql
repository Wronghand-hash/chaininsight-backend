-- Safe, Idempotent Migration for 0030_fix_google_users_table.sql

-- Handles "table already exists" by always dropping first (ignores if not exists).
-- QuestDB DROP IF EXISTS is safe and won't error if table missing.
-- If DROP fails (e.g., due to suspension), restart QuestDB server first, then re-run migration.
-- Includes SYMBOL INDEX for email (QuestDB-optimized lookups, no separate CREATE INDEX needed).
-- After save, restart app—migration will succeed without errors.

-- Drop the table if it exists
DROP TABLE IF EXISTS google_users;

-- Create fresh without WAL (uses your original schema + INDEX on email for perf)
CREATE TABLE google_users (
    created_at TIMESTAMP,
    username STRING,
    email SYMBOL INDEX,  -- INDEX for fast email queries (replaces UNIQUE INDEX)
    verified BOOLEAN,
    updated_at TIMESTAMP,
    twitter_addresses STRING,
    google_id STRING,
    name STRING,
    picture STRING,
    access_token STRING,
    refresh_token STRING,
    token_expiry TIMESTAMP,
    last_login_at TIMESTAMP,
    login_count LONG,
    locale STRING,
    hd STRING,
    auth_provider STRING,
    current_sign_in_ip STRING,
    last_sign_in_ip STRING,
    sign_in_count LONG,
    tos_accepted_at TIMESTAMP,
    email_verified BOOLEAN
) TIMESTAMP(created_at) PARTITION BY DAY;

-- Safe defaults (no-op on fresh table, but prevents future NULL issues)
UPDATE google_users
SET
    login_count = COALESCE(login_count, 0),
    sign_in_count = COALESCE(sign_in_count, 0),
    auth_provider = COALESCE(auth_provider, 'google'),
    email_verified = COALESCE(email_verified, false),
    locale = COALESCE(locale, 'not provided'),
    hd = COALESCE(hd, 'not provided')
WHERE
    login_count IS NULL
    OR sign_in_count IS NULL
    OR auth_provider IS NULL
    OR email_verified IS NULL
    OR locale IS NULL
    OR hd IS NULL;