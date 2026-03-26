import { randomBytes } from 'crypto'
import { getCategoryForType, CATEGORY_LABEL } from '../constants/eventCategories.js'
import { getScreenshotImageUrlFromData } from '../utils/screenshotImageUrl.js'
import ExtensionUser from '../models/ExtensionUser.js'

export function makeLogId() {
  return `LOG_${randomBytes(16).toString('hex')}`
}

export function tsToIso(ts) {
  if (ts == null) return new Date().toISOString()
  const n = typeof ts === 'number' ? ts : Date.parse(String(ts))
  return new Date(Number.isFinite(n) ? n : Date.now()).toISOString()
}

function extractApplication(storedData) {
  if (!storedData || !storedData.url) return 'browser'
  try {
    return new URL(storedData.url).hostname || 'browser'
  } catch {
    return 'browser'
  }
}

function mapOperation(type) {
  const t = (type || 'unknown').replace(/[^a-zA-Z0-9_]/g, '_')
  return t.length > 64 ? t.slice(0, 64) : t
}

function buildLogDetailsPayload(item, ev, storedData) {
  const base = {
    type: ev.type || 'unknown',
    sessionId: item.sessionId,
    pageId: item.pageId,
    projectId: item.projectId || 'discovery-ai'
  }
  if (item.employeeIdentifier) base.employeeIdentifier = String(item.employeeIdentifier).slice(0, 256)
  if (item.extensionMeta && typeof item.extensionMeta === 'object') {
    base.extensionMeta = item.extensionMeta
  }
  if (!storedData || typeof storedData !== 'object') {
    return JSON.stringify({ web: base })
  }
  const d = storedData
  const slim = { ...base }
  if (d.url) slim.url = String(d.url).slice(0, 2000)
  if (d.title) slim.title = String(d.title).slice(0, 500)
  if (d.reason) slim.reason = String(d.reason).slice(0, 200)
  if (d.tabId != null) slim.tabId = d.tabId
  if (d.fileSizeKB != null) slim.fileSizeKB = d.fileSizeKB
  if (d.screenshotId) slim.screenshotId = String(d.screenshotId).slice(0, 80)
  if (d.totalActiveMs != null) slim.totalActiveMs = d.totalActiveMs
  if (d.status) slim.status = String(d.status).slice(0, 80)
  if (item.extensionMeta && typeof item.extensionMeta === 'object') {
    slim.extensionMeta = item.extensionMeta
  }
  return JSON.stringify({ web: slim })
}

function buildApplicationTab(application, windowTitle, storedData) {
  const title = (windowTitle || '').trim()
  if (title) {
    const line = `${application} | ${title}`
    return line.length > 512 ? `${line.slice(0, 511)}…` : line
  }
  if (storedData?.url) {
    try {
      const u = new URL(storedData.url)
      const path = `${u.pathname}${u.search}` || '/'
      const line = `${application} | ${path}`
      return line.length > 512 ? `${line.slice(0, 511)}…` : line
    } catch {
      const line = `${application} | ${String(storedData.url).slice(0, 400)}`
      return line.length > 512 ? `${line.slice(0, 511)}…` : line
    }
  }
  return application
}

export function buildCanonicalRows({
  item,
  ev,
  storedData,
  ip,
  insertedId,
  logId
}) {
  const type = ev.type || 'unknown'
  const catKey = getCategoryForType(type)
  const category = CATEGORY_LABEL[catKey] || catKey
  const application = extractApplication(storedData)
  const windowTitle =
    (storedData && (storedData.title || storedData.pageTitle)) != null
      ? String(storedData.title || storedData.pageTitle || '')
      : ''
  const application_tab = buildApplicationTab(application, windowTitle, storedData)
  const screenshotId = ev.data?.screenshotId ?? item.screenshotId ?? null

  const details = buildLogDetailsPayload(item, ev, storedData)

  const logRow = {
    log_id: logId,
    user_id: item.userId,
    ip: ip || '',
    ts: tsToIso(item.ts),
    category,
    category_key: catKey,
    event_type: type,
    session_id: item.sessionId || '',
    page_id: item.pageId || '',
    project_id: item.projectId || 'discovery-ai',
    details,
    application,
    window_title: windowTitle,
    application_tab,
    operation: mapOperation(type),
    screenshot_id: screenshotId,
    created_at: new Date().toISOString(),
    legacy_event_id: insertedId
  }

  let screenshotRow = null
  if (type === 'screenshot' && screenshotId) {
    const screenshotUrl =
      getScreenshotImageUrlFromData(storedData) || (storedData && storedData.imageUrl) || ''
    screenshotRow = {
      screenshot_id: screenshotId,
      user_id: item.userId,
      ip: ip || '',
      ts: tsToIso(item.ts),
      application,
      window_title: windowTitle,
      application_tab,
      operation: String(storedData?.reason || type || 'screenshot'),
      screenshot_url: screenshotUrl,
      created_at: new Date().toISOString(),
      legacy_event_id: insertedId
    }
  }

  return { logRow, screenshotRow }
}

function normalizeCollectEmail(s) {
  if (s == null || typeof s !== 'string') return ''
  const t = s.trim().toLowerCase()
  if (!t || !t.includes('@')) return ''
  return t.slice(0, 320)
}

function isRegisteredExtensionUser(u) {
  return !!(u && (u.username || u.passwordHash))
}

/** Persist extension-reported browser/OS from collect batches (Chrome vs Edge, etc.). */
function buildExtensionClientFields(meta) {
  if (!meta || typeof meta !== 'object') return null
  const o = {}
  if (meta.browserName) o.extensionBrowserName = String(meta.browserName).slice(0, 80)
  if (meta.os) o.extensionOs = String(meta.os).slice(0, 80)
  if (meta.userAgent) o.extensionUserAgent = String(meta.userAgent).slice(0, 512)
  if (meta.extensionVersion) o.extensionVersionLast = String(meta.extensionVersion).slice(0, 32)
  return Object.keys(o).length ? o : null
}

/**
 * Link telemetry to plugin_users by email (primary) or trackerUserId.
 * When email is present, avoids duplicate anonymous rows and merges ghost docs.
 */
export async function upsertTrackerUserFromCollect(userId, employeeIdentifier, extUserDoc, clientIp, extensionMeta) {
  if (!userId) return
  const now = new Date().toISOString()
  const emailNorm = normalizeCollectEmail(employeeIdentifier)
  const clientFields = buildExtensionClientFields(extensionMeta)
  const setBase = {
    last_seen_at: now,
    lastIp: clientIp || '',
    ...(clientFields || {})
  }
  if (extUserDoc?.projectId) setBase.projectId = extUserDoc.projectId
  if (extUserDoc?.name) setBase.name = extUserDoc.name
  if (extUserDoc?.email) setBase.email = extUserDoc.email

  try {
    if (emailNorm) {
      const byEmail = await ExtensionUser.findOne({ email: emailNorm })
      const byTracker = await ExtensionUser.findOne({ trackerUserId: userId })

      if (byEmail && byTracker && byEmail._id.toString() !== byTracker._id.toString()) {
        const rE = isRegisteredExtensionUser(byEmail)
        const rT = isRegisteredExtensionUser(byTracker)
        if (rE && !rT) {
          await ExtensionUser.deleteOne({ _id: byTracker._id })
          await ExtensionUser.updateOne(
            { _id: byEmail._id },
            { $set: { ...setBase, trackerUserId: userId, email: emailNorm } }
          )
        } else if (!rE && rT) {
          await ExtensionUser.deleteOne({ _id: byEmail._id })
          await ExtensionUser.updateOne(
            { _id: byTracker._id },
            { $set: { ...setBase, email: emailNorm } }
          )
        } else {
          await ExtensionUser.deleteOne({ _id: byTracker._id })
          await ExtensionUser.updateOne(
            { _id: byEmail._id },
            { $set: { ...setBase, trackerUserId: userId, email: emailNorm } }
          )
        }
        return
      }

      if (byEmail) {
        await ExtensionUser.updateOne(
          { _id: byEmail._id },
          { $set: { ...setBase, trackerUserId: userId, email: emailNorm } }
        )
        return
      }

      if (byTracker) {
        await ExtensionUser.updateOne(
          { _id: byTracker._id },
          { $set: { ...setBase, email: emailNorm } }
        )
        return
      }

      await ExtensionUser.create({
        trackerUserId: userId,
        email: emailNorm,
        first_seen_ip: clientIp || '',
        last_seen_at: now,
        lastIp: clientIp || '',
        ...(clientFields || {})
      })
      return
    }

    const r = await ExtensionUser.updateMany({ trackerUserId: userId }, { $set: setBase })
    if (r.matchedCount === 0) {
      await ExtensionUser.create({
        trackerUserId: userId,
        first_seen_ip: clientIp || '',
        last_seen_at: now,
        lastIp: clientIp || '',
        ...(clientFields || {})
      })
    }
  } catch (e) {
    console.error('[telemetry] plugin_users upsert failed:', e.message)
  }
}
