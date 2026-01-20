# 🎮 FC26 Ultimate Sniper Bot

Професійний торговий бот для EA FC 26 Ultimate Team з Telegram інтерфейсом.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green)
![License](https://img.shields.io/badge/license-MIT-yellow)

## ✨ Можливості

- 🤖 **Автоматичний снайпинг** - купує гравців за заданими фільтрами
- 💰 **Автопродаж** - автоматично виставляє куплених гравців на продаж
- 📊 **Інтеграція з FUTBIN/FUT.GG** - актуальні ціни з популярних сервісів
- 📱 **Telegram бот** - повне керування через Telegram
- 🔒 **Шифрування** - безпечне зберігання cookies та даних
- 📈 **Статистика** - відстеження прибутку та активності
- ⚡ **Швидкість** - оптимізовані запити до EA API

## 🏗️ Архітектура

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Telegram Bot   │────▶│  Sniper Engine  │────▶│    EA API       │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│    Supabase     │◀───▶│  Price Service  │────▶│ FUTBIN/FUT.GG   │
│    Database     │     │    (Cache)      │     │     APIs        │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

## 🚀 Швидкий старт

### 1. Клонування репозиторію

```bash
git clone https://github.com/your-username/fc26-bot.git
cd fc26-bot
```

### 2. Встановлення залежностей

```bash
npm install
```

### 3. Налаштування Supabase

1. Створіть проект на [supabase.com](https://supabase.com)
2. Відкрийте SQL Editor
3. Виконайте скрипт з `src/database/schema.sql`

### 4. Створення Telegram бота

1. Напишіть [@BotFather](https://t.me/BotFather) в Telegram
2. Створіть нового бота командою `/newbot`
3. Збережіть токен бота

### 5. Налаштування змінних середовища

```bash
cp .env.example .env
```

Відредагуйте `.env` файл:

```env
# Telegram
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ADMIN_IDS=your_telegram_id

# Supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_KEY=your_service_key

# Security
ENCRYPTION_KEY=your_32_character_key
```

### 6. Запуск

```bash
# Розробка
npm run dev

# Продакшн
npm run build
npm start
```

## ☁️ Деплой на Railway

### Автоматичний деплой

1. Форкніть цей репозиторій
2. Зайдіть на [railway.app](https://railway.app)
3. Створіть новий проект з GitHub
4. Додайте змінні середовища в Settings → Variables

### Змінні для Railway

| Змінна | Опис |
|--------|------|
| `TELEGRAM_BOT_TOKEN` | Токен Telegram бота |
| `TELEGRAM_ADMIN_IDS` | ID адміністраторів |
| `SUPABASE_URL` | URL вашого Supabase проекту |
| `SUPABASE_ANON_KEY` | Публічний ключ Supabase |
| `SUPABASE_SERVICE_KEY` | Сервісний ключ Supabase |
| `ENCRYPTION_KEY` | 32-символьний ключ шифрування |
| `MIN_SEARCH_DELAY` | Мін. затримка між пошуками (мс) |
| `MAX_SEARCH_DELAY` | Макс. затримка між пошуками (мс) |
| `MAX_PURCHASES_PER_HOUR` | Ліміт покупок на годину |
| `MIN_PROFIT_MARGIN` | Мін. маржа прибутку (%) |

## 📱 Використання бота

### Основні команди

| Команда | Опис |
|---------|------|
| `/start` | Почати роботу з ботом |
| `/accounts` | Керування EA акаунтами |
| `/add_account` | Додати новий акаунт |
| `/filters` | Керування фільтрами |
| `/add_filter` | Створити новий фільтр |
| `/start_sniper` | Запустити снайпер |
| `/stop_sniper` | Зупинити снайпер |
| `/status` | Статус активних сесій |
| `/stats` | Статистика за 7 днів |
| `/prices <імʼя>` | Перевірити ціни гравця |

### Як отримати cookies

1. Відкрийте [EA FC Web App](https://www.ea.com/ea-sports-fc/ultimate-team/web-app)
2. Увійдіть у свій акаунт
3. Натисніть `F12` → вкладка `Network`
4. Оновіть сторінку
5. Знайдіть будь-який запит до `fut.ea.com`
6. Скопіюйте cookies з заголовків

Формат cookies для бота:

```json
{
  "sid": "your_session_id",
  "personaId": "your_persona_id",
  "nucleusId": "your_nucleus_id",
  "phishing": "your_phishing_token"
}
```

## ⚙️ Конфігурація

### Налаштування швидкості

```env
# Агресивний режим (більший ризик)
MIN_SEARCH_DELAY=1500
MAX_SEARCH_DELAY=3000
MAX_PURCHASES_PER_HOUR=100

# Безпечний режим
MIN_SEARCH_DELAY=4000
MAX_SEARCH_DELAY=7000
MAX_PURCHASES_PER_HOUR=30
```

### Налаштування прибутку

```env
# Мінімальна маржа прибутку (у відсотках)
MIN_PROFIT_MARGIN=5

# Бот купуватиме тільки якщо потенційний прибуток >= 5%
```

## 📊 Структура бази даних

### Таблиці

- `users` - користувачі Telegram
- `ea_accounts` - EA акаунти з зашифрованими cookies
- `sniper_filters` - фільтри для снайпингу
- `transactions` - історія операцій
- `price_cache` - кеш цін
- `bot_stats` - щоденна статистика

## 🔒 Безпека

- ✅ Cookies шифруються AES-256
- ✅ Ключі зберігаються в змінних середовища
- ✅ Row Level Security в Supabase
- ✅ Перевірка адмінів по Telegram ID

## ⚠️ Застереження

> **УВАГА:** Використання ботів порушує Terms of Service EA Sports. 
> Використовуйте на свій страх і ризик!

Можливі наслідки:
- Тимчасове блокування трансферного ринку
- Перманентний бан акаунту

Рекомендації:
- Не використовуйте на основному акаунті
- Дотримуйтесь лімітів запитів
- Робіть перерви між сесіями

## 🐛 Відомі проблеми

1. **Сесія закінчується** - Cookies мають обмежений термін дії. Оновлюйте їх регулярно.
2. **Капча** - EA може показати капчу. Пройдіть її в Web App.
3. **Ринок заблоковано** - Зачекайте або зверніться до EA Support.

## 🤝 Контрибуція

Pull requests вітаються! Для великих змін спочатку відкрийте issue.

## 📄 Ліцензія

MIT License - дивіться [LICENSE](LICENSE)

---

<p align="center">
  Made with ❤️ for FC26 traders
</p>
