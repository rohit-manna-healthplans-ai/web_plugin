import { Router } from 'express'
import { randomUUID } from 'crypto'
import mongoose from 'mongoose'
import ExtensionUser from '../models/ExtensionUser.js'
import ActivityLog from '../models/ActivityLog.js'
import ScreenshotRecord from '../models/ScreenshotRecord.js'
import { isAzureConfigured, buildScreenshotBlobPath, uploadScreenshotBuffer } from '../services/azureBlobUpload.js'
import { getScreenshotImageUrlFromData } from '../utils/screenshotImageUrl.js'
import {
  buildCanonicalRows,
  makeLogId,
  upsertTrackerUserFromCollect
} from '../services/telemetryCanonical.js'

const router = Router()

if (!isAzureConfigured()) {
  console.warn('⚠️  [Azure Blob] Screenshot uploads disabled: set AZURE_STORAGE_CONNECTION_STRING (screenshots will use dataUrl only).')
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for']
  if (typeof xf === 'string') return xf.split(',')[0].trim()
  return req.ip || req.connection?.remoteAddress || ''
}

router.post('/', async (req, res) => {
  try {
    const apiKeyHeader = req.headers['x-api-key'] || req.query['x-api-key']
    const expected = process.env.EXTENSION_API_KEY
    if (expected && apiKeyHeader !== expected) {
      console.log('Invalid API key:', { received: apiKeyHeader?.substring(0, 10), expected: expected?.substring(0, 10) })
      return res.status(401).json({ error: 'Invalid API key' })
    }

    const batch = Array.isArray(req.body) ? req.body : [req.body]
    const metaForCanonical = []
    const ip = clientIp(req)

    console.log(`Received batch of ${batch.length} events from IP: ${ip}`)

    let extUser = null
    const sample = batch[0]
    const employeeIdentifier = batch.map((i) => i.employeeIdentifier).find((x) => x && String(x).trim())
    const extensionMeta = batch.map((i) => i.extensionMeta).find((x) => x && typeof x === 'object')
    if (sample && sample.userId) {
      try {
        await upsertTrackerUserFromCollect(sample.userId, employeeIdentifier, null, ip, extensionMeta)
      } catch (e) {
        console.error('[collect] plugin_users upsert failed:', e.message)
      }
      extUser = await ExtensionUser.findOne({ trackerUserId: sample.userId })
      if (!extUser && employeeIdentifier) {
        const em = String(employeeIdentifier).trim().toLowerCase()
        if (em.includes('@')) extUser = await ExtensionUser.findOne({ email: em })
      }
      if (extUser) {
        console.log(`Found extension user for trackerUserId: ${sample.userId}`)
      } else {
        console.log(`No extension user found for trackerUserId: ${sample.userId}`)
      }
      if (extUser && ip) {
        ExtensionUser.updateOne({ _id: extUser._id }, { $set: { lastIp: ip } }).catch(() => {})
      }
    }

    for (const item of batch) {
      const ev = item.event || {}

      if (ev.type === 'screenshot' && ev.data && ev.data.dataUrl) {
        let imageBuffer = null
        const skipAzure = !isAzureConfigured()

        try {
          const dataUrl = ev.data.dataUrl
          if (!skipAzure) {
            console.log(`[Azure Blob] Processing screenshot from extension (dataUrl length: ${dataUrl.length})`)
          }

          const b64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '')
          if (!b64 || b64 === dataUrl) {
            if (!skipAzure) console.warn('[Azure Blob] Invalid screenshot dataUrl format, skipping upload')
          } else {
            imageBuffer = Buffer.from(b64, 'base64')
            if (skipAzure) {
              ev.data = { ...ev.data, fileSizeKB: Math.round(imageBuffer.length / 1024) }
            } else {
              console.log(`[Azure Blob] Uploading screenshot (${Math.round(imageBuffer.length / 1024)}KB)...`)
            }

            if (!skipAzure) {
              const userId = item.userId
              const screenshotId = ev.data.screenshotId ?? item.screenshotId ?? randomUUID()
              const eventDate = item.ts ? new Date(item.ts) : new Date()
              const blobPath = buildScreenshotBlobPath(userId, screenshotId, eventDate)
              const uploaded = await uploadScreenshotBuffer(imageBuffer, blobPath)
              const fileSizeKB = Math.round(imageBuffer.length / 1024)
              console.log('[Azure Blob] ✅ Screenshot uploaded')
              ev.data = {
                ...ev.data,
                screenshotId,
                dataUrl: undefined,
                imageUrl: uploaded.imageUrl,
                azureBlobPath: uploaded.azureBlobPath,
                azureContainer: uploaded.azureContainer,
                storageProvider: uploaded.storageProvider,
                width: ev.data.width,
                height: ev.data.height,
                fileSizeKB
              }
            }
          }
        } catch (screenshotError) {
          console.error('[Azure Blob] ❌ Screenshot upload failed:', screenshotError.message || screenshotError)
          try {
            const dataUrl = ev.data.dataUrl || ''
            const base64Part = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
            if (base64Part && !imageBuffer) {
              imageBuffer = Buffer.from(base64Part, 'base64')
            }
            if (imageBuffer) {
              ev.data.fileSizeKB = Math.round(imageBuffer.length / 1024)
            }
          } catch (_) {}
          console.log('[Azure Blob]   dataUrl will be stripped before DB insert (memory)')
        }
      }

      if (!item.ts) {
        console.warn('Event missing ts, skipping:', item)
        continue
      }

      let storedData = ev.data || null
      if (ev.type === 'screenshot' && storedData) {
        const remoteUrl = getScreenshotImageUrlFromData(storedData)
        if (storedData.dataUrl && remoteUrl) {
          const { dataUrl: _strip, ...rest } = storedData
          storedData = rest
        }
        if (storedData.dataUrl) {
          const du = storedData.dataUrl
          const approxKb = storedData.fileSizeKB ?? Math.max(1, Math.round((String(du).length * 3) / 4 / 1024))
          const { dataUrl: _d, ...rest } = storedData
          storedData = { ...rest, fileSizeKB: approxKb }
          if (!remoteUrl) {
            console.log(`[Collect] Stripped dataUrl (no blob URL). Metadata only ~${approxKb}KB`)
          }
        }
        ev.data = storedData
      }

      const insertedId = new mongoose.Types.ObjectId()
      metaForCanonical.push({ item, ev, storedData, insertedId })
    }

    if (metaForCanonical.length) {
      try {
        const logDocs = []
        const shotDocs = []
        for (const row of metaForCanonical) {
          const { item, ev, storedData, insertedId } = row
          const { logRow, screenshotRow } = buildCanonicalRows({
            item,
            ev,
            storedData,
            ip,
            insertedId,
            logId: makeLogId()
          })
          // Raw image payload lives in `screenshots` only; avoid duplicate rows in `logs`.
          if (ev.type !== 'screenshot') {
            logDocs.push(logRow)
          }
          if (screenshotRow) shotDocs.push(screenshotRow)
        }
        if (logDocs.length) {
          await ActivityLog.insertMany(logDocs, { ordered: false })
          console.log(`[collect] Inserted ${logDocs.length} rows into logs`)
        }
        if (shotDocs.length) {
          await ScreenshotRecord.insertMany(shotDocs, { ordered: false })
          console.log(`[collect] Inserted ${shotDocs.length} rows into screenshots`)
        }
      } catch (canonicalErr) {
        console.error('[collect] logs/screenshots insert failed:', canonicalErr.message)
      }
    } else {
      console.log('No events to insert')
    }

    res.json({ success: true, received: metaForCanonical.length })
  } catch (e) {
    console.error('collector error:', e)
    res.status(500).json({ error: 'collector error', details: e.message })
  }
})

router.get('/remote-commands', async (req, res) => {
  try {
    const apiKeyHeader = req.headers['x-api-key'] || req.query['x-api-key']
    const expected = process.env.EXTENSION_API_KEY
    if (expected && apiKeyHeader !== expected) {
      return res.status(401).json({ error: 'Invalid API key' })
    }

    const trackerUserId = req.query.trackerUserId
    if (!trackerUserId) {
      return res.status(400).json({ error: 'trackerUserId is required' })
    }

    const u = await ExtensionUser.findOne({ trackerUserId }).select('remoteCommands').lean()
    if (!u || !u.remoteCommands?.length) {
      return res.json({ commands: [] })
    }

    const now = new Date()
    const pending = u.remoteCommands
      .filter((c) => c.status === 'pending' && (!c.expiresAt || new Date(c.expiresAt) > now))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))

    const cmd = pending[0]
    if (!cmd) {
      return res.json({ commands: [] })
    }

    await ExtensionUser.updateOne(
      { _id: u._id, 'remoteCommands._id': cmd._id },
      { $set: { 'remoteCommands.$.status': 'delivered', 'remoteCommands.$.deliveredAt': new Date() } }
    )

    res.json({
      commands: [
        {
          _id: cmd._id,
          command: cmd.command,
          sessionName: cmd.sessionName || '',
          createdAt: cmd.createdAt
        }
      ]
    })
  } catch (e) {
    console.error('[collect/remote-commands] Error:', e)
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/remote-commands/ack', async (req, res) => {
  try {
    const apiKeyHeader = req.headers['x-api-key'] || req.query['x-api-key']
    const expected = process.env.EXTENSION_API_KEY
    if (expected && apiKeyHeader !== expected) {
      return res.status(401).json({ error: 'Invalid API key' })
    }

    const { commandId } = req.body
    if (!commandId) {
      return res.status(400).json({ error: 'commandId is required' })
    }

    await ExtensionUser.updateOne(
      { 'remoteCommands._id': commandId },
      { $set: { 'remoteCommands.$.status': 'executed', 'remoteCommands.$.executedAt': new Date() } }
    )

    res.json({ success: true })
  } catch (e) {
    console.error('[collect/remote-commands/ack] Error:', e)
    res.status(500).json({ error: 'Server error' })
  }
})

export default router
