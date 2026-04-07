# Feasable WhatsApp Backend Server

WhatsApp messaging backend using whatsapp-web.js + Puppeteer. Deploys to Render free tier.

## Deploy to Render

### Option 1: Blueprint (Easiest)
1. Go to https://dashboard.render.com/blueprint
2. Connect your GitHub repo: `pararchy/feasable-holdings`
3. Select the `mobile-app/server` directory
4. Render will auto-detect the `render.yaml` and Dockerfile
5. Click "Apply"

### Option 2: Manual Web Service
1. Go to https://dashboard.render.com/new
2. Select "Web Service"
3. Connect `pararchy/feasable-holdings` repo
4. Configure:
   - **Name**: `feasable-whatsapp-api`
   - **Runtime**: Docker
   - **Root Directory**: `mobile-app/server`
   - **Plan**: Free
   - **Env Vars**:
     - `PORT=3001`
     - `NODE_ENV=production`
     - `CHROMIUM_PATH=/usr/bin/chromium`
5. Add Disk:
   - **Name**: `whatsapp-data`
   - **Mount Path**: `/app/data`
   - **Size**: 1 GB (Free tier max)
6. Deploy

### Health Check
Once deployed, verify:
```
https://feasable-whatsapp-api.onrender.com/health
```

Should return:
```json
{
  "status": "ok",
  "whatsapp": "disconnected",
  "queueSize": 0,
  ...
}
```

## Environment Variables (Netlify)

After deploying, set in Netlify:
```bash
netlify env:set BAILEYS_SERVER_URL "https://feasable-whatsapp-api.onrender.com"
netlify env:set GREEN_API_INSTANCE_ID "REPLACE_ME"  # Not using GREEN-API
netlify env:set GREEN_API_TOKEN "REPLACE_ME"       # Not using GREEN-API
```

Then redeploy frontend.

## Local Development

```bash
cd mobile-app/server
npm install
npm run build
npm start
```

## Architecture

- **Server**: Express + whatsapp-web.js + Puppeteer
- **Smart Scheduling**: 10-20s delays, 2min pause every 25 messages, 3 retries
- **Max 500 contacts/campaign**
- **Queue persisted** to disk (`/app/data/queue.json`)

## API Endpoints

- `GET /health` - Health check
- `GET /status` - Connection status
- `GET /qr` - QR code (base64)
- `POST /pairing-code` - Request pairing code
- `POST /campaign` - Send campaign
- `GET /campaign/:id` - Campaign status
- `GET /campaigns` - All campaigns
- `POST /reconnect` - Reconnect WhatsApp
- `POST /disconnect` - Disconnect WhatsApp
