-- 0024_add_google_columns_to_users.sql
-- Add google_id column
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id STRING;
