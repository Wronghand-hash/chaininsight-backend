CREATE TABLE google_users (
  created_at TIMESTAMP,
  username STRING,
  email SYMBOL,
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

-- Set defaults for new rows (idempotent UPDATE)
UPDATE google_users
SET
  login_count = COALESCE(login_count, 0),
  sign_in_count = COALESCE(sign_in_count, 0),
  auth_provider = COALESCE(auth_provider, 'google'),
  email_verified = COALESCE(email_verified, false)
WHERE
  login_count IS NULL
  OR sign_in_count IS NULL
  OR auth_provider IS NULL
  OR email_verified IS NULL;