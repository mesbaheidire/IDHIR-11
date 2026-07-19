# AffiliDz

An automated AliExpress affiliate marketing platform for Telegram channel owners (targeting the Algerian market). Enables link conversion, AI content generation, channel spying, and scheduled publishing to Telegram and Facebook.

## Run & Operate

- **Start**: `npm start` (runs `node server.js`)
- **Required secrets**: `DATABASE_URL` (auto-set by Replit DB), `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `cook` (AliExpress session cookie)
- **Optional**: `ALIEXPRESS_APP_KEY`, `ALIEXPRESS_APP_SECRET`, `ALIEXPRESS_TRACK_ID`, `TELEGRAM_CHANNEL_ID`, `FACEBOOK_PAGE_ID`, `FACEBOOK_PAGE_TOKEN` (override DB-stored Facebook credentials; recommended for Render deployment)

## Stack

- **Runtime**: Node.js 20
- **Framework**: Express 5
- **Database**: PostgreSQL via `pg` (Replit managed)
- **AI**: Google Gemini (`@google/generative-ai`)
- **Telegram**: Telegraf (bot) + telegram (MTProto for spy)
- **Frontend**: Vanilla HTML/CSS/JS (PWA)
- **Image processing**: sharp, multer
- **Other**: axios, got, xlsx, cors, dotenv

## Where things live

- `server.js` — Main Express server (3700+ lines, all API routes)
- `db.js` — PostgreSQL schema + all DB helpers
- `spy.js` — Telegram channel monitoring (MTProto)
- `afflink.js` — AliExpress affiliate link conversion
- `aliexpress-api.js` — AliExpress product search API
- `scheduler.js` — Scheduled post queue
- `facebook.js` — Facebook Page posting
- `public/` — All frontend HTML pages (PWA)
- `public/index.html` — Main dashboard

## Architecture decisions

- Credentials are loaded from env vars first, then DB (`app_storage` table), then local file (`app_credentials.json`) as fallback
- Gemini API keys support rotation — multiple keys stored in `gemini_keys.json` or env var (comma-separated)
- DB tables are auto-created on startup via `initDatabase()` in `db.js`
- Port defaults to `5000` (Replit webview compatible), overridable via `PORT` env var
- No authentication layer — app is intended for single-owner use with credentials stored in settings UI

## Product

- Convert AliExpress product links to affiliate links
- Generate AI marketing copy (hooks, titles) via Gemini
- Monitor competitor Telegram channels ("Spy" mode)
- Schedule and auto-publish posts to Telegram channels and Facebook pages
- Bulk import products from Excel files
- PWA installable on mobile

## User preferences

_Populate as you build_

## Gotchas

- The spy module requires Telegram API ID/Hash (MTProto) — different from bot token
- First startup may log a DB error for `spy_config` table not existing — this is harmless, tables are created shortly after
- AliExpress cookie (`cook`) expires and must be refreshed periodically
- `sharp` requires native binaries — already installed via npm

## Pointers

- DB skill: `.local/skills/database/SKILL.md`
- Workflows skill: `.local/skills/workflows/SKILL.md`
- Secrets skill: `.local/skills/environment-secrets/SKILL.md`
