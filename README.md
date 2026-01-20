# FC26 Ultimate Sniper Bot v2.0

## 🚀 Швидкий старт

### 1. Замініть існуючий проект
Просто видаліть всі файли свого проекту і скопіюйте цю папку.

### 2. Встановіть залежності
```bash
npm install
```

### 3. Налаштуйте .env
Скопіюйте `.env.example` в `.env` і заповніть:
- `TELEGRAM_BOT_TOKEN` - токен від @BotFather
- `SUPABASE_URL` - URL вашого Supabase проекту
- `SUPABASE_ANON_KEY` - anon key
- `SUPABASE_SERVICE_KEY` - service key
- `ENCRYPTION_KEY` - мінімум 32 символи (для шифрування cookies)

### 4. Налаштуйте базу даних (див. нижче)

### 5. Запустіть
```bash
npm run build
npm start
```

Або для розробки:
```bash
npm run dev
```

---

## 📊 База даних (Supabase)

### Якщо у вас НОВА база - виконайте весь SQL:

```sql
-- ==========================================
-- ТАБЛИЦЯ: users
-- ==========================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_telegram_id ON users(telegram_id);

-- ==========================================
-- ТАБЛИЦЯ: ea_accounts
-- ==========================================
CREATE TABLE IF NOT EXISTS ea_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ps', 'xbox', 'pc')),
  session_id TEXT,
  cookies_encrypted TEXT,
  coins INTEGER DEFAULT 0,
  last_login TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ea_accounts_user_id ON ea_accounts(user_id);

-- ==========================================
-- ТАБЛИЦЯ: sniper_filters
-- ==========================================
CREATE TABLE IF NOT EXISTS sniper_filters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  ea_account_id UUID REFERENCES ea_accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  player_id INTEGER,
  min_buy INTEGER,
  max_buy INTEGER NOT NULL,
  sell_price INTEGER,
  position TEXT,
  quality TEXT,
  rarity TEXT,
  nation INTEGER,
  league INTEGER,
  club INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_filters_account ON sniper_filters(ea_account_id);

-- ==========================================
-- ТАБЛИЦЯ: trade_history
-- ==========================================
CREATE TABLE IF NOT EXISTS trade_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ea_account_id UUID REFERENCES ea_accounts(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL,
  player_name TEXT NOT NULL,
  buy_price INTEGER NOT NULL,
  sell_price INTEGER,
  profit INTEGER,
  status TEXT DEFAULT 'bought' CHECK (status IN ('bought', 'listed', 'sold', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trade_history_account ON trade_history(ea_account_id);
CREATE INDEX idx_trade_history_created ON trade_history(created_at);

-- ==========================================
-- RLS (Row Level Security) - ОПЦІЙНО
-- ==========================================
-- Якщо хочете додаткову безпеку:

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE ea_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sniper_filters ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_history ENABLE ROW LEVEL SECURITY;

-- Дозволити service role повний доступ
CREATE POLICY "Service role full access" ON users FOR ALL USING (true);
CREATE POLICY "Service role full access" ON ea_accounts FOR ALL USING (true);
CREATE POLICY "Service role full access" ON sniper_filters FOR ALL USING (true);
CREATE POLICY "Service role full access" ON trade_history FOR ALL USING (true);
```

### Якщо у вас ІСНУЮЧА база - перевірте колонки:

Нова версія потребує колонку `cookies_encrypted` в таблиці `ea_accounts`:

```sql
-- Перевірте чи є колонка:
SELECT column_name FROM information_schema.columns 
WHERE table_name = 'ea_accounts' AND column_name = 'cookies_encrypted';

-- Якщо немає - додайте:
ALTER TABLE ea_accounts ADD COLUMN IF NOT EXISTS cookies_encrypted TEXT;
```

---

## 🆕 Нові можливості v2.0

### 1. Повна авторизація EA
- Email + Password + 2FA
- Кешування cookies (не потрібен SID кожен раз)
- Автоматичне оновлення сесії

### 2. Anti-Ban система
- Затримки 7-15 сек між запитами
- Ліміти: 350 пошуків/год, 25 покупок/год
- Нічний режим 02:00-08:00
- Рівні ризику в реальному часі

### 3. Captcha підтримка
- Ручне вирішення через Telegram
- Anti-Captcha / 2Captcha API (опційно)

---

## 📱 Команди бота

| Команда | Опис |
|---------|------|
| `/start` | Початок роботи |
| `/accounts` | Керування EA акаунтами |
| `/add_account` | Додати новий акаунт |
| `/filters` | Керування фільтрами |
| `/start_sniper` | Запустити снайпер |
| `/stop_sniper` | Зупинити снайпер |
| `/status` | Статус бота |
| `/risk` | Рівні ризику |
| `/settings` | Налаштування Anti-Ban |
| `/stats` | Статистика |
| `/2fa <код>` | Ввести 2FA код |

---

## ⚠️ Anti-Ban параметри

| Параметр | Значення | НЕ ЗМІНЮЙ! |
|----------|----------|------------|
| Затримка пошуку | 7-15 сек | ⚠️ |
| Max пошуків/год | 350 | ⚠️ |
| Max покупок/год | 25 | ⚠️ |
| Max запитів/год | 400 | ⚠️ |
| Max запитів/день | 5000 | ⚠️ |

---

## 🔴 Критичні error коди

| Код | Опис | Дія бота |
|-----|------|----------|
| 421 | Too many requests | Пауза |
| 429 | Rate limited | СТОП |
| 458 | Transfer locked | СТОП |
| 461 | Permission denied | СТОП |
| 512 | Market locked | СТОП |

---

## 📁 Структура проекту

```
fc26-sniper-bot/
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts              # Точка входу
│   ├── config/
│   │   └── index.ts          # Конфігурація
│   ├── bot/
│   │   └── telegram-bot.ts   # Telegram бот
│   ├── services/
│   │   ├── anti-ban.ts       # Anti-Ban система
│   │   ├── ea-auth.ts        # EA авторизація
│   │   ├── ea-api.ts         # EA API клієнт
│   │   ├── captcha-solver.ts # Капча сервіс
│   │   ├── sniper-engine.ts  # Логіка снайпера
│   │   └── price-service.ts  # Ціни FUTBIN/FUT.GG
│   ├── database/
│   │   └── index.ts          # Supabase клієнт
│   └── utils/
│       └── logger.ts         # Логування
```

---

## 🚀 Деплой на Railway

1. Створіть новий проект на Railway
2. Підключіть GitHub репозиторій
3. Додайте змінні оточення (Settings → Variables):
   - Всі змінні з `.env.example`
4. Railway автоматично задеплоїть

---

## ❓ Troubleshooting

### "Session expired"
- Використайте `/accounts` → Оновити сесію
- Або додайте акаунт заново через `/add_account`

### "Captcha required"
- Відкрийте EA FC Web App в браузері
- Пройдіть капчу
- Бот продовжить автоматично

### "Rate limited (429)"
- Бот автоматично зупиниться
- Зачекайте 30-60 хвилин
- Перевірте `/risk`

### "Invalid SID format"
- SID має бути у форматі: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`
- Скопіюйте повний SID з DevTools

---

## ⚠️ УВАГА

**Використання на власний ризик!**

EA може заблокувати акаунт за використання автоматизації. Ця система мінімізує ризик, але не гарантує 100% безпеку.

Рекомендації:
- Не запускайте 24/7
- Використовуйте нічний режим
- Слідкуйте за рівнем ризику (`/risk`)
- При 80%+ ризику - зупиняйте бота
