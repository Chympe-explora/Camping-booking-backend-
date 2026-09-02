# ✅ Camping Booking Backend - Setup Instructions

## 🎯 What This Is

This is the **complete fixed backend** for your Team Explo Era adventure booking system.

**Technology:** Cloudflare Workers + Telegram Bot Integration  
**Status:** ✅ Ready to deploy  
**Key Fix:** `wrangler.toml` has been updated with correct `SITE_BASE_URL`

---

## 🚀 Quick Deploy (5 minutes)

### Step 1: Prerequisites

Make sure you have:
```bash
node --version      # Should show: v16.x.x or higher
npm --version       # Should show: 8.x.x or higher
git --version       # Should show: git version 2.x.x
```

**If missing, install:**
- Node.js: https://nodejs.org/
- Git: https://git-scm.com/

### Step 2: Navigate to Project

```bash
cd Camping-booking-backend
```

### Step 3: Install Dependencies

```bash
npm install
```

Wait for completion (1-2 minutes).

### Step 4: Authenticate with Cloudflare

```bash
wrangler login
```

A browser window opens → Log in with your Cloudflare account → Click Authorize → Done

### Step 5: Deploy to Cloudflare Workers

```bash
npx wrangler deploy
```

**You should see:**
```
✓ Published to https://chympe-booking-backend.workers.dev
```

### Step 6: Test It Works

```bash
curl https://chympe-booking-backend.workers.dev/api/content?site=root
```

**Should return JSON** (not error)

---

## ✅ That's It!

Your backend is now deployed and working. ✨

---

## 📁 What's Included

```
Camping-booking-backend/
├── wrangler.toml              ← ✅ FIXED with correct SITE_BASE_URL
├── package.json               ← Dependencies
├── src/
│   ├── index.js               ← Main API router
│   ├── booking.js             ← Booking endpoints
│   ├── content-api.js         ← Content/pricing endpoints
│   ├── telegram-bot.js        ← Telegram admin bot
│   ├── era-ai.js              ← AI chat assistant
│   ├── pricing.js             ← Price calculations
│   ├── ratings.js             ← Visitor ratings
│   ├── reviews.js             ← Reviews management
│   ├── store.js               ← Data storage
│   ├── stats.js               ← Statistics
│   ├── conversations.js       ← Chat conversations
│   ├── telegram.js            ← Telegram utilities
│   ├── telegram-bot-additions.js
│   ├── content-schema.js      ← Content schema
│   └── walker.js              ← Tree walking utilities
│
└── SETUP_INSTRUCTIONS.md      ← This file
```

---

## 🔧 Configuration

### wrangler.toml - ALREADY FIXED ✅

This file has been updated with:

```toml
# ✅ This is now correct:
SITE_BASE_URL = "https://chympe-explora.github.io/team-explo-era-site/"

# Your Telegram settings:
TELEGRAM_CHAT_ID = "-1003766158262"
TELEGRAM_ADMIN_CHAT_ID = "8550710288"
ADMIN_USER_IDS = "8550710288"
```

### Environment Secrets (First Time Only)

You need to set these one-time secrets. In terminal:

```bash
# Telegram bot token (from @BotFather)
wrangler secret put TELEGRAM_BOT_TOKEN
# → Paste your token → Press Enter → Ctrl+D (Mac) or Ctrl+Z (Windows)

# Random secret for webhooks
wrangler secret put WEBHOOK_SECRET
# → Paste something like: abc123xyz789secret → Press Enter → Ctrl+D/Ctrl+Z

# Random secret for admin API
wrangler secret put ADMIN_API_SECRET
# → Paste something like: admin_secret_123 → Press Enter → Ctrl+D/Ctrl+Z
```

**Verify secrets are set:**
```bash
wrangler secret list
```

Should show all three secrets.

---

## 🚀 API Endpoints

Your backend provides these endpoints:

### Content & Pricing
```
GET  /api/content?site=root|krem-chympe|wilderness-expedition
GET  /api/prices?site=root
GET  /api/images?site=root
GET  /api/highlights?site=root
POST /api/calculate-price
```

### Bookings
```
POST /api/visit          ← User visits site
POST /api/tap            ← User taps item
POST /api/draft          ← User creates draft
POST /api/submit         ← User submits booking
GET  /api/status/:id     ← Check booking status
```

### AI Chat (ERA)
```
POST /api/era/message    ← Send message to AI
GET  /api/era/poll       ← Get AI response
POST /api/era/typing     ← User is typing
```

### Ratings
```
GET  /api/ratings?site=root
POST /api/ratings        ← Submit rating
```

---

## 🔄 Redeploy (After Making Changes)

If you make changes to the code:

```bash
# Edit files as needed

# Commit and push
git add .
git commit -m "Description of changes"
git push origin main

# Deploy
npx wrangler deploy
```

---

## 🆘 Troubleshooting

### "wrangler: command not found"
```bash
npm install -g wrangler
```

### "Cannot find module"
```bash
npm install
npx wrangler deploy
```

### "Unauthorized (401)" error
```bash
wrangler logout
wrangler login
npx wrangler deploy
```

### Deployment times out
```bash
# Try again (sometimes Cloudflare is slow)
npx wrangler deploy
```

### "KV namespace does not exist"
```bash
# The namespace ID might be wrong. Create a new one:
wrangler kv:namespace create BOOKINGS

# Copy the ID it gives you
# Open wrangler.toml and update the id in:
# kv_namespaces = [ { binding = "BOOKINGS", id = "PASTE_HERE" } ]

# Then redeploy
npx wrangler deploy
```

### API returns 404
```bash
# Check deployment was successful
wrangler deployments list

# If last deployment failed, redeploy
npm install
npx wrangler deploy
```

---

## 📋 Testing Endpoints

### Test if backend is running

```bash
curl https://chympe-booking-backend.workers.dev/api/content?site=root
```

Should return JSON with your site configuration.

### Test booking submission

```bash
curl -X POST https://chympe-booking-backend.workers.dev/api/submit \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test User",
    "email": "test@example.com",
    "phone": "9160018775",
    "package": "Cave Expedition",
    "total": 5000
  }'
```

Should return booking confirmation.

---

## 🔗 Integration with Frontend

The frontend (`team-eplo-era-site`) automatically connects to this backend.

**Frontend uses these endpoints:**
- Fetches site content from `/api/content`
- Submits bookings to `/api/submit`
- Gets prices from `/api/calculate-price`

**File that connects them:** `team-explo-era-site/live-content.js`

```javascript
// This is already set correctly:
const BACKEND_URL = "https://chympe-booking-backend.workers.dev";
```

---

## 📊 View Backend Logs

To see what's happening on your backend:

```bash
wrangler tail
```

This shows real-time logs of requests and errors.

---

## 🗑️ Reset Everything

If you want to start fresh:

```bash
# Delete all bookings and content from KV
wrangler kv:key delete --namespace-id cd92b965c0ed4581bebe2cb0b941d9cb "*"

# WARNING: This deletes everything! Use with caution.
```

---

## 📞 Quick Reference

**Backend URL:** `https://chympe-booking-backend.workers.dev`

**Test backend:**
```bash
curl https://chympe-booking-backend.workers.dev/api/content?site=root
```

**Deploy:**
```bash
npx wrangler deploy
```

**View logs:**
```bash
wrangler tail
```

**List deployments:**
```bash
wrangler deployments list
```

---

## ✅ Deployment Checklist

Before deploying, verify:

- [ ] You have Node.js installed
- [ ] You have Cloudflare account
- [ ] You have Telegram bot token
- [ ] `npm install` completed without errors
- [ ] `wrangler login` succeeded
- [ ] Secrets are set (`wrangler secret list`)
- [ ] `wrangler.toml` has correct `SITE_BASE_URL`

Then:
```bash
npx wrangler deploy
```

Wait for success message and test with curl.

---

## 🎯 What Happens Next

1. ✅ Backend deploys to Cloudflare Workers
2. ✅ Frontend can access backend APIs
3. ✅ Bookings are saved and forwarded to Telegram
4. ✅ Admin bot receives notifications
5. ✅ Visitors can submit forms and contact you via WhatsApp

---

## 📚 Additional Resources

- **Cloudflare Workers Docs:** https://developers.cloudflare.com/workers/
- **Wrangler CLI Docs:** https://developers.cloudflare.com/workers/wrangler/install-and-update/
- **Telegram Bot API:** https://core.telegram.org/bots/api

---

## ✨ You're All Set!

This backend is completely fixed and ready to run.

**Frontend Setup:** See `team-explo-era-site/SETUP_INSTRUCTIONS.md`

**Status:** ✅ Ready to Deploy

---

**Version:** 1.0 - September 2, 2026  
**Status:** ✅ Fully Fixed  
