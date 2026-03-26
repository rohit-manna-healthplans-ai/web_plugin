# Local Development Setup

## Prerequisites
1. Node.js 18+ installed
2. MongoDB running locally OR MongoDB Atlas connection string

## Quick Start

### 1. Install Dependencies
```bash
cd discovery-ai-backend
npm install
```

### 2. Set Up Environment Variables
Create or update `.env` file with:

```env
# Server
PORT=4001

# Database (use local MongoDB or Atlas)
MONGO_URI=mongodb://127.0.0.1:27017/
# OR for MongoDB Atlas — same URI you use in server; database name is separate:
# MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/?appName=MyApp
# Logical database name (collections go here; created automatically on first write):
MONGO_DBNAME=claims_demo

# Azure Blob Storage (screenshots — optional; without it OCR still works from dataUrl)
# Connection string from Azure Portal → Storage account → Access keys
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net
# Container name (created automatically if missing). Default: screenshots
AZURE_STORAGE_CONTAINER=screenshots

# Extension API Key
EXTENSION_API_KEY=discovery_ext_7Kp9Xb2Q

# JWT Secret (generate a random string)
JWT_SECRET=your_secret_key_here_change_this
```

### 3. Start MongoDB (if using local)
```bash
# Windows (if installed as service, it should auto-start)
# Or download MongoDB Community Server and run:
mongod

# Or use MongoDB Atlas (cloud) - no local install needed
```

### 4. Run the Server
```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm start
```

The server will start on `http://localhost:4001` (default in `server.js`; override with `PORT` in `.env`)

### 5. Update Frontend to Use Local Backend
In `discovery-ai/.env`:
```env
REACT_APP_DISCOVERY_BACKEND=http://localhost:4000
```

Then restart the frontend:
```bash
cd discovery-ai
npm start
```

## Chrome extension + local backend

1. **Load unpacked:** `chrome://extensions` → Developer mode → **Load unpacked** → select the `extension` folder (`C:\Web_plugin\extension`).
2. **Backend running:** `npm run dev` in `discovery-ai-backend-main` — console should show `Mongo connected (database: claims_demo)` (or your `MONGO_DBNAME`) and `Backend running on http://localhost:4001`.
3. **URLs must match:** `extension/service-worker.js` and `popup.js` use `http://localhost:4001` as `BACKEND_BASE_URL` (same port as server default).
4. **After code changes:** On the extensions page, click **Reload** on the extension.
5. **How it works:** The service worker batches events (page views, screenshots, etc.) and `POST`s them to `/api/collect`. Screenshots go to Azure (if configured) + OCR; data lands in MongoDB under your **`MONGO_DBNAME`** (default `claims_demo`). Open the extension popup to see backend **Connected** if `/api/collect/remote-commands` responds.
6. **First-time user id:** The popup / flow sets a `trackerUserId` in `chrome.storage.local` — events include that id so you can find rows in MongoDB Compass by `userId` / collections like `screenshot_events`.

## Testing OCR

### Test with Manual OCR Endpoint
Once server is running, you can test OCR manually:

```bash
# Get a screenshot event ID from your database or API
# Then call:
curl -X POST http://localhost:4001/api/analytics/screenshots/EVENT_ID/process-ocr \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Reprocess Existing Screenshots
```bash
npm run reprocess-ocr
```

## Troubleshooting

### MongoDB Connection Issues
- Make sure MongoDB is running: `mongosh` or check service status
- Or use MongoDB Atlas (cloud) - update MONGO_URI in .env

### Port Already in Use
- Change PORT in .env to something else (e.g., 4001)
- Or kill the process using port 4001 (or change `PORT` in `.env`)

### OCR Not Working
- Check that `tesseract.js` and `sharp` are installed: `npm list tesseract.js sharp`
- Check server logs for OCR errors
- Try the manual OCR endpoint first

