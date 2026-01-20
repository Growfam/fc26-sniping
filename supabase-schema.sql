-- FC26 Sniper Database Schema
-- Run this in Supabase SQL Editor

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT UNIQUE NOT NULL,
    username TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sniper filters
CREATE TABLE IF NOT EXISTS sniper_filters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL,
    player_name TEXT,
    player_id BIGINT,
    rating_min INT,
    rating_max INT,
    max_buy_price INT NOT NULL,
    sell_price INT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Stats (one row per user, updated by userscript)
CREATE TABLE IF NOT EXISTS sniper_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT UNIQUE NOT NULL,
    searches INT DEFAULT 0,
    found INT DEFAULT 0,
    bought INT DEFAULT 0,
    profit BIGINT DEFAULT 0,
    errors INT DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Purchase log
CREATE TABLE IF NOT EXISTS purchase_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT NOT NULL,
    player_name TEXT,
    player_id BIGINT,
    buy_price INT NOT NULL,
    sell_price INT,
    profit INT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_filters_user ON sniper_filters(user_id);
CREATE INDEX IF NOT EXISTS idx_filters_active ON sniper_filters(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchase_log(user_id);
CREATE INDEX IF NOT EXISTS idx_stats_user ON sniper_stats(user_id);

-- Enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sniper_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE sniper_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_log ENABLE ROW LEVEL SECURITY;

-- Policies for public access (userscript uses anon key)
CREATE POLICY "Allow all on users" ON users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on filters" ON sniper_filters FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on stats" ON sniper_stats FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all on purchases" ON purchase_log FOR ALL USING (true) WITH CHECK (true);
