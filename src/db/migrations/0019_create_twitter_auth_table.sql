CREATE TABLE IF NOT EXISTS twitter_auth (
    timestamp TIMESTAMP,
    id SYMBOL,
    username STRING,
    access_token STRING,
    refresh_token STRING,
    expires_at TIMESTAMP,
    scope STRING,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
) TIMESTAMP(timestamp) PARTITION BY DAY WAL;
