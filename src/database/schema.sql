-- ==========================================
-- FC26 ULTIMATE SNIPER - DATABASE SCHEMA
-- Run this in Supabase SQL Editor
-- ==========================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==========================================
-- USERS TABLE
-- ==========================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    telegram_id BIGINT UNIQUE NOT NULL,
    username VARCHAR(255),
    is_active BOOLEAN DEFAULT true,
    is_admin BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_telegram_id ON users(telegram_id);

-- ==========================================
-- EA ACCOUNTS TABLE
-- ==========================================
CREATE TABLE IF NOT EXISTS ea_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    platform VARCHAR(10) NOT NULL CHECK (platform IN ('ps', 'xbox', 'pc')),
    persona_id VARCHAR(255),
    nucleus_id VARCHAR(255),
    session_id VARCHAR(500),
    phishing_token VARCHAR(500),
    cookies_encrypted TEXT,
    coins BIGINT DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ea_accounts_user_id ON ea_accounts(user_id);
CREATE INDEX idx_ea_accounts_active ON ea_accounts(is_active);

-- ==========================================
-- SNIPER FILTERS TABLE
-- ==========================================
CREATE TABLE IF NOT EXISTS sniper_filters (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    ea_account_id UUID REFERENCES ea_accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    player_id BIGINT,
    min_buy BIGINT,
    max_buy BIGINT NOT NULL,
    sell_price BIGINT,
    position VARCHAR(10),
    quality VARCHAR(20),
    rarity VARCHAR(50),
    nation INT,
    league INT,
    club INT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sniper_filters_account ON sniper_filters(ea_account_id);
CREATE INDEX idx_sniper_filters_active ON sniper_filters(is_active);

-- ==========================================
-- TRANSACTIONS TABLE
-- ==========================================
CREATE TABLE IF NOT EXISTS transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    ea_account_id UUID REFERENCES ea_accounts(id) ON DELETE CASCADE,
    filter_id UUID REFERENCES sniper_filters(id) ON DELETE SET NULL,
    player_id BIGINT NOT NULL,
    player_name VARCHAR(255) NOT NULL,
    buy_price BIGINT NOT NULL,
    sell_price BIGINT,
    profit BIGINT,
    status VARCHAR(20) DEFAULT 'bought' CHECK (status IN ('bought', 'listed', 'sold', 'expired')),
    trade_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    sold_at TIMESTAMPTZ
);

CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_transactions_account ON transactions(ea_account_id);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_date ON transactions(created_at);

-- ==========================================
-- PRICE CACHE TABLE
-- ==========================================
CREATE TABLE IF NOT EXISTS price_cache (
    player_id BIGINT NOT NULL,
    platform VARCHAR(10) NOT NULL,
    futbin_price BIGINT,
    futgg_price BIGINT,
    lowest_bin BIGINT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (player_id, platform)
);

CREATE INDEX idx_price_cache_updated ON price_cache(updated_at);

-- ==========================================
-- BOT STATS TABLE
-- ==========================================
CREATE TABLE IF NOT EXISTS bot_stats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    ea_account_id UUID REFERENCES ea_accounts(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    searches INT DEFAULT 0,
    purchases INT DEFAULT 0,
    sales INT DEFAULT 0,
    profit BIGINT DEFAULT 0,
    coins_start BIGINT DEFAULT 0,
    coins_end BIGINT DEFAULT 0,
    UNIQUE(user_id, ea_account_id, date)
);

CREATE INDEX idx_bot_stats_date ON bot_stats(date);

-- ==========================================
-- BOT SESSIONS TABLE (for active sniping)
-- ==========================================
CREATE TABLE IF NOT EXISTS bot_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    ea_account_id UUID REFERENCES ea_accounts(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'stopped' CHECK (status IN ('running', 'paused', 'stopped', 'error')),
    started_at TIMESTAMPTZ,
    stopped_at TIMESTAMPTZ,
    last_activity TIMESTAMPTZ DEFAULT NOW(),
    requests_this_hour INT DEFAULT 0,
    purchases_this_hour INT DEFAULT 0,
    error_message TEXT,
    UNIQUE(ea_account_id)
);

-- ==========================================
-- PLAYER DATABASE TABLE (cached from FUTBIN)
-- ==========================================
CREATE TABLE IF NOT EXISTS players (
    id BIGINT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    rating INT,
    position VARCHAR(10),
    nation INT,
    league INT,
    club INT,
    rarity VARCHAR(50),
    card_type VARCHAR(50),
    pace INT,
    shooting INT,
    passing INT,
    dribbling INT,
    defending INT,
    physical INT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_players_name ON players(name);
CREATE INDEX idx_players_rating ON players(rating);

-- ==========================================
-- FUNCTIONS
-- ==========================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ea_accounts_updated_at
    BEFORE UPDATE ON ea_accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ==========================================
-- ROW LEVEL SECURITY (Optional but recommended)
-- ==========================================

-- Enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE ea_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sniper_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_stats ENABLE ROW LEVEL SECURITY;

-- Policies (service role bypasses these)
-- Users can only see their own data
CREATE POLICY "Users can view own data" ON users
    FOR SELECT USING (true);

CREATE POLICY "Users can update own data" ON users
    FOR UPDATE USING (true);

-- ==========================================
-- VIEWS FOR ANALYTICS
-- ==========================================

-- Daily profit summary
CREATE OR REPLACE VIEW daily_profit_summary AS
SELECT 
    user_id,
    DATE(created_at) as date,
    COUNT(*) FILTER (WHERE status = 'bought') as total_purchases,
    COUNT(*) FILTER (WHERE status = 'sold') as total_sales,
    SUM(profit) FILTER (WHERE status = 'sold') as total_profit,
    AVG(profit) FILTER (WHERE status = 'sold') as avg_profit_per_card
FROM transactions
GROUP BY user_id, DATE(created_at);

-- Top performing filters
CREATE OR REPLACE VIEW filter_performance AS
SELECT 
    f.id as filter_id,
    f.name as filter_name,
    f.user_id,
    COUNT(t.id) as total_transactions,
    SUM(t.profit) FILTER (WHERE t.status = 'sold') as total_profit,
    AVG(t.profit) FILTER (WHERE t.status = 'sold') as avg_profit
FROM sniper_filters f
LEFT JOIN transactions t ON t.filter_id = f.id
GROUP BY f.id, f.name, f.user_id;
