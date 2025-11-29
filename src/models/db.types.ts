export type TableRow = any[];  // e.g., [timestamp: Date, contract: string, ...]

export interface QueryResult {
    rows: TableRow[];
    columns: string[];
}

// Typed rows for specific tables (optional, for type safety in services)
export type PriceRow = [Date, string, number, number, string];  // timestamp, contract, priceUsd, volume, chain
export type KolTradeRow = [Date, number, string, string, number, string];  // timestamp, kolId, contract, action, amount, chain
export type TokenInfoRow = [Date, string, string, string];  // timestamp, contract, data (JSON str), chain
export type SecurityRow = [Date, string, string, string];  // timestamp, address, data (JSON str), chain
export type TwitterAuthRow = [Date, string, string, string, string, Date, string, Date, Date, string, string];  // timestamp, id, username, access_token, refresh_token, expires_at, scope, created_at, updated_at, profile_image_url, email