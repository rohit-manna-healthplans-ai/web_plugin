import { Router } from 'express'
import ExtensionUser from '../models/ExtensionUser.js'
import ActivityLog from '../models/ActivityLog.js'
import ScreenshotRecord from '../models/ScreenshotRecord.js'
import { verifyToken } from '../utils/auth.js'
import {
  findEvents,
  countEvents,
  getAllModels
} from '../services/eventStore.js'
const router = Router()

// Simple in-memory cache for expensive queries
const cache = new Map()
const CACHE_TTL = 30 * 1000 // 30 seconds

function getCached(key) {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key)
    return null
  }
  return entry.data
}

function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() })
  // Clean old entries periodically
  if (cache.size > 100) {
    const now = Date.now()
    for (const [k, v] of cache) {
      if (now - v.ts > CACHE_TTL) cache.delete(k)
    }
  }
}

// Helper to extract extension user id from normal auth token
async function getExtUserFromAuth(req) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return { user: null, hasToken: false, tokenError: null }
  
  try {
    const payload = verifyToken(token)
    if (!payload || !payload.sub) {
      return { user: null, hasToken: true, tokenError: new Error('Invalid token payload') }
    }
    const extUser = await ExtensionUser.findById(payload.sub).select('_id trackerUserId username').lean()
    if (!extUser) {
      return { user: null, hasToken: true, tokenError: new Error('User not found') }
    }
    return { user: extUser, hasToken: true, tokenError: null }
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      console.log('[getExtUserFromAuth] Token expired')
    } else if (e.name === 'JsonWebTokenError') {
      console.log('[getExtUserFromAuth] Invalid token format/signature:', e.message)
    } else {
      console.error('[getExtUserFromAuth] Token error:', e.name, e.message)
    }
    return { user: null, hasToken: true, tokenError: e }
  }
}

// ----- OPTIMIZED Overview endpoint - Single aggregation for all metrics -----
router.get('/overview', async (req, res) => {
  try {
    const { user: extUser } = await getExtUserFromAuth(req)
    const { projectId } = req.query
    
    const match = {}
    if (extUser) {
      match.user_id = extUser.trackerUserId
    }
    if (projectId) match.project_id = projectId

    // Check cache first
    const cacheKey = `overview_${extUser?.trackerUserId || 'all'}_${projectId || 'all'}`
    const cached = getCached(cacheKey)
    if (cached) {
      return res.json(cached)
    }

    const startTime = Date.now()

    const facetPipeline = [
      { $match: match },
      {
        $facet: {
          totalEvents: [{ $count: 'count' }],
          eventTypes: [{ $group: { _id: '$event_type', count: { $sum: 1 } } }],
          sessions: [
            {
              $group: {
                _id: { $ifNull: ['$session_id', '$page_id'] },
                start: { $min: { $toDate: '$ts' } },
                end: { $max: { $toDate: '$ts' } }
              }
            }
          ]
        }
      }
    ]

    const collectionResults = await Promise.all(
      getAllModels().map((M) => M.aggregate(facetPipeline).allowDiskUse(true))
    )

    const [screenshotAgg] = await ActivityLog.aggregate([
      { $match: { ...match, event_type: 'screenshot' } },
      {
        $facet: {
          count: [{ $count: 'count' }],
          sessionsWithScreenshots: [
            { $group: { _id: '$session_id' } },
            { $count: 'count' }
          ]
        }
      }
    ]).allowDiskUse(true)

    // Merge results from all collections
    let totalEvents = 0
    const byType = {}
    const sessionMap = new Map() // Merge sessions across collections

    for (const [result] of collectionResults) {
      if (!result) continue
      totalEvents += result.totalEvents?.[0]?.count || 0
      ;(result.eventTypes || []).forEach(et => {
        if (et._id) byType[et._id] = (byType[et._id] || 0) + et.count
      })
      ;(result.sessions || []).forEach(s => {
        const existing = sessionMap.get(s._id)
        if (existing) {
          existing.start = Math.min(existing.start, s.start)
          existing.end = Math.max(existing.end, s.end)
        } else {
          sessionMap.set(s._id, { ...s })
        }
      })
    }

    const sessions = [...sessionMap.values()].filter(s => s.end > s.start)
    const totalSessions = sessions.length
    const screenshots = screenshotAgg?.count?.[0]?.count || 0
    const sessionsWithScreenshots = screenshotAgg?.sessionsWithScreenshots?.[0]?.count || 0

    // Calculate average duration from sessions
    const avgDuration = sessions.length > 0
      ? sessions.reduce((sum, s) => {
          const duration = s.end && s.start ? (s.end - s.start) / 1000 : 0
          return sum + duration
        }, 0) / sessions.length
      : 0

    console.log(`[overview] Query completed in ${Date.now() - startTime}ms`)

    const response = {
      metrics: {
        totalSessions,
        totalEvents,
        screenshots,
        sessionsWithScreenshots,
        avgTimeSec: Math.round(avgDuration),
        byType
      },
      charts: {
        sessionsOverTime: []
      }
    }

    setCache(cacheKey, response)
    res.json(response)
  } catch (e) {
    console.error('overview error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

// ----- OPTIMIZED Sessions endpoint -----
router.get('/sessions', async (req, res) => {
  try {
    const { user: extUser, hasToken, tokenError } = await getExtUserFromAuth(req)
    if (!extUser) {
      if (hasToken && tokenError) {
        const errorMsg = tokenError.name === 'TokenExpiredError' 
          ? 'Token expired' 
          : tokenError.name === 'JsonWebTokenError'
          ? 'Invalid token - please log in again'
          : 'Invalid token'
        return res.status(401).json({ error: 'Unauthorized', details: errorMsg })
      }
      return res.json([])
    }

    const { limit = 100, projectId } = req.query
    const match = { user_id: extUser.trackerUserId }
    if (projectId) match.project_id = projectId

    // Check cache
    const cacheKey = `sessions_${extUser.trackerUserId}_${projectId || 'all'}_${limit}`
    const cached = getCached(cacheKey)
    if (cached) {
      return res.json(cached)
    }

    const startTime = Date.now()

    const sessionPipeline = [
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ['$session_id', '$page_id'] },
          start: { $min: { $toDate: '$ts' } },
          end: { $max: { $toDate: '$ts' } },
          count: { $sum: 1 },
          userId: { $first: '$user_id' }
        }
      }
    ]

    const allResults = await Promise.all(
      getAllModels().map(M => M.aggregate(sessionPipeline).allowDiskUse(true))
    )

    // Merge sessions from all collections
    const sessionMap = new Map()
    for (const results of allResults) {
      for (const s of results) {
        const existing = sessionMap.get(s._id)
        if (existing) {
          existing.start = Math.min(existing.start, s.start)
          existing.end = Math.max(existing.end, s.end)
          existing.count += s.count
          if (!existing.userId) existing.userId = s.userId
        } else {
          sessionMap.set(s._id, { ...s })
        }
      }
    }

    const sessions = [...sessionMap.values()]
      .filter(s => s.end > s.start)
      .sort((a, b) => b.end - a.end)
      .slice(0, Math.min(Number(limit) || 100, 500))

    console.log(`[sessions] Query completed in ${Date.now() - startTime}ms, found ${sessions.length} sessions`)

    const formattedSessions = sessions.map(s => {
      const startMs = s.start ? new Date(s.start).getTime() : null
      const endMs = s.end ? new Date(s.end).getTime() : null
      const durationSec = startMs && endMs ? Math.round((endMs - startMs) / 1000) : 0
      
      return {
        sessionId: s._id || `session_${s.start}`,
        start: s.start,
        end: s.end,
        durationSec: durationSec,
        count: s.count,
        userId: s.userId
      }
    })

    setCache(cacheKey, formattedSessions)
    res.json(formattedSessions)
  } catch (e) {
    console.error('sessions error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

// ----- OPTIMIZED Events endpoint -----
router.get('/events', async (req, res) => {
  try {
    const { user: extUser } = await getExtUserFromAuth(req)
    const { type, limit = 200, projectId, sessionId } = req.query
    
    const q = {}
    if (extUser) {
      q.userId = extUser.trackerUserId
    }
    if (type) q.type = type
    if (projectId) q.projectId = projectId
    if (sessionId) q.sessionId = sessionId // Filter by session for detail page!

    // Check cache - include sessionId in key
    const cacheKey = `events_${extUser?.trackerUserId || 'all'}_${type || 'all'}_${projectId || 'all'}_${sessionId || 'all'}_${limit}`
    const cached = getCached(cacheKey)
    if (cached) {
      return res.json(cached)
    }

    const startTime = Date.now()

    // Query across organized event collections
    const items = await findEvents(q, {
      select: 'ts sessionId pageId userId projectId type data ip tabId url title',
      sort: { ts: -1 },
      limit: Math.min(Number(limit), 2000),
      lean: true
    })

    console.log(`[events] Query completed in ${Date.now() - startTime}ms, found ${items.length} events`)

    setCache(cacheKey, items)
    res.json(items)
  } catch (e) {
    console.error('events error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

// ----- OPTIMIZED Screenshots endpoint -----
router.get('/screenshots', async (req, res) => {
  try {
    const { user: extUser } = await getExtUserFromAuth(req)
    const { limit = 50, projectId, sessionId } = req.query
    
    if (!extUser) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    // Check cache
    const cacheKey = `screenshots_${extUser?.trackerUserId || 'all'}_${projectId || 'all'}_${sessionId || 'all'}_${limit}`
    const cached = getCached(cacheKey)
    if (cached) {
      return res.json(cached)
    }

    const startTime = Date.now()

    const shotQ = { user_id: extUser.trackerUserId }
    const items = await ScreenshotRecord.find(shotQ)
      .sort({ ts: -1 })
      .limit(Math.min(Number(limit), 100))
      .lean()

    console.log(`[screenshots] Query completed in ${Date.now() - startTime}ms, found ${items.length} screenshots`)

    setCache(cacheKey, items)
    res.json(items)
  } catch (e) {
    console.error('screenshots error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

// ----- TABS — from `logs` rows with category_key === 'tab' -----
router.get('/tabs', async (req, res) => {
  try {
    const { user: extUser } = await getExtUserFromAuth(req)
    const { projectId } = req.query
    if (!extUser) return res.json([])

    const cacheKey = `tabs_${extUser?.trackerUserId || 'all'}_${projectId || 'all'}`
    const cached = getCached(cacheKey)
    if (cached) return res.json(cached)

    const startTime = Date.now()
    const q = { user_id: extUser.trackerUserId, category_key: 'tab' }
    if (projectId) q.project_id = projectId

    const rows = await ActivityLog.find(q).sort({ ts: -1 }).limit(800).lean()
    const processedTabs = rows
      .map((r) => {
        let web = {}
        try {
          web = JSON.parse(r.details || '{}').web || {}
        } catch {
          web = {}
        }
        const url = web.url || ''
        if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
          return null
        }
        return {
          tabId: web.tabId ?? r.session_id ?? url,
          url,
          title: web.title || r.window_title || 'Untitled',
          created: r.ts,
          lastUpdated: r.ts,
          activations: r.event_type === 'tab_activated' ? 1 : 0,
          totalActiveMs: 0,
          sessionCount: 1,
          eventCount: 1
        }
      })
      .filter(Boolean)

    console.log(`[tabs] Query completed in ${Date.now() - startTime}ms, found ${processedTabs.length} tabs`)
    setCache(cacheKey, processedTabs)
    res.json(processedTabs)
  } catch (e) {
    console.error('tabs error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

// ----- Extension user "my data" endpoints -----
router.get('/me/sessions', async (req, res) => {
  try {
    const { user: extUser, hasToken, tokenError } = await getExtUserFromAuth(req)
    if (!extUser) {
      if (hasToken && tokenError) {
        return res.status(401).json({ error: 'Unauthorized', details: tokenError.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token' })
      }
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { limit = 100 } = req.query
    const match = { userId: extUser.trackerUserId }

    // Aggregate sessions across all event collections
    const sessionPipe = [
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ['$sessionId', '$pageId'] },
          start: { $min: '$ts' },
          end: { $max: '$ts' },
          count: { $sum: 1 },
          userId: { $first: '$userId' }
        }
      }
    ]
    const allRes = await Promise.all(getAllModels().map(M => M.aggregate(sessionPipe).allowDiskUse(true)))
    const sMap = new Map()
    for (const arr of allRes) {
      for (const s of arr) {
        const ex = sMap.get(s._id)
        if (ex) { ex.start = Math.min(ex.start, s.start); ex.end = Math.max(ex.end, s.end); ex.count += s.count; if (!ex.userId) ex.userId = s.userId }
        else sMap.set(s._id, { ...s })
      }
    }
    const sessions = [...sMap.values()].sort((a, b) => b.end - a.end).slice(0, Number(limit))

    res.json(sessions)
  } catch (e) {
    console.error('me/sessions error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

router.get('/me/events', async (req, res) => {
  try {
    const { user: extUser, hasToken, tokenError } = await getExtUserFromAuth(req)
    if (!extUser) {
      if (hasToken && tokenError) {
        return res.status(401).json({ error: 'Unauthorized', details: tokenError.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token' })
      }
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { type, limit = 200 } = req.query
    const q = { userId: extUser.trackerUserId }
    if (type) q.type = type

    const items = await findEvents(q, { sort: { ts: -1 }, limit: Number(limit), lean: true })
    res.json(items)
  } catch (e) {
    console.error('me/events error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

// Legacy path — server-side OCR disabled (saves memory on small hosts)
router.post('/screenshots/:eventId/process-ocr', async (req, res) => {
  res.status(410).json({
    success: false,
    error: 'OCR has been removed from the server',
    message: 'Screenshot images are still stored; text extraction is not performed.'
  })
})

// Debug endpoint
router.get('/me/debug', async (req, res) => {
  try {
    const { user: extUser, hasToken, tokenError } = await getExtUserFromAuth(req)
    if (!extUser) {
      if (hasToken && tokenError) {
        return res.status(401).json({ error: 'Unauthorized', details: tokenError.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token' })
      }
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const eventCount = await countEvents({ userId: extUser.trackerUserId })
    const sampleEvents = await findEvents({ userId: extUser.trackerUserId }, { limit: 5, select: 'ts type sessionId pageId userId', lean: true })
    
    res.json({
      extUser: {
        id: extUser._id,
        username: extUser.username,
        trackerUserId: extUser.trackerUserId
      },
      eventCount,
      sampleEvents
    })
  } catch (e) {
    console.error('me/debug error:', e)
    res.status(500).json({ error: 'debug error', details: e.message })
  }
})

// ----- Admin endpoints -----

router.get('/users', async (req, res) => {
  try {
    const cacheKey = 'admin_users'
    const cached = getCached(cacheKey)
    if (cached) return res.json(cached)

    // Aggregate users across all event collections
    const userPipeline = [
      { $match: { user_id: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: '$user_id',
          events: { $sum: 1 },
          firstTs: { $min: { $toDate: '$ts' } },
          lastTs: { $max: { $toDate: '$ts' } }
        }
      }
    ]
    const allUserResults = await Promise.all(getAllModels().map(M => M.aggregate(userPipeline).allowDiskUse(true)))
    
    // Merge user stats from all collections
    const userMap = new Map()
    for (const results of allUserResults) {
      for (const u of results) {
        const existing = userMap.get(u._id)
        if (existing) {
          existing.events += u.events
          existing.firstTs = Math.min(existing.firstTs || Infinity, u.firstTs || Infinity)
          existing.lastTs = Math.max(existing.lastTs || 0, u.lastTs || 0)
        } else {
          userMap.set(u._id, { ...u })
        }
      }
    }
    const users = [...userMap.values()].sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0)).slice(0, 200)

    const userIds = users.map(u => u._id)
    const extensionUsers = await ExtensionUser.find({ trackerUserId: { $in: userIds } })
      .select('trackerUserId username')
      .lean()
    
    const extUserMap = new Map()
    extensionUsers.forEach(u => {
      extUserMap.set(u.trackerUserId, u)
    })

    const result = users.map((u) => {
      const extUser = extUserMap.get(u._id)
      return {
        userId: u._id,
        username: extUser?.username || null,
        email: extUser?.username ? `${extUser.username}@ext` : null,
        events: u.events,
        firstTs: u.firstTs,
        lastTs: u.lastTs
      }
    })

    setCache(cacheKey, result)
    res.json(result)
  } catch (e) {
    console.error('analytics users error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

router.get('/users/:userId/sessions', async (req, res) => {
  try {
    const { limit = 100 } = req.query
    const { userId } = req.params

    // Aggregate sessions across all event collections
    const sPipe = [
      { $match: { user_id: userId } },
      {
        $group: {
          _id: { $ifNull: ['$session_id', '$page_id'] },
          start: { $min: { $toDate: '$ts' } },
          end: { $max: { $toDate: '$ts' } },
          count: { $sum: 1 },
          userId: { $first: '$user_id' }
        }
      }
    ]
    const allSRes = await Promise.all(getAllModels().map(M => M.aggregate(sPipe).allowDiskUse(true)))
    const sMap = new Map()
    for (const arr of allSRes) {
      for (const s of arr) {
        const ex = sMap.get(s._id)
        if (ex) { ex.start = Math.min(ex.start, s.start); ex.end = Math.max(ex.end, s.end); ex.count += s.count; if (!ex.userId) ex.userId = s.userId }
        else sMap.set(s._id, { ...s })
      }
    }
    const sessions = [...sMap.values()].filter(s => s.end > s.start).sort((a, b) => b.end - a.end).slice(0, Math.min(Number(limit) || 100, 500))

    const formattedSessions = sessions.map(s => ({
      sessionId: s._id || `session_${s.start}`,
      start: s.start,
      end: s.end,
      durationSec: s.start && s.end ? Math.round((s.end - s.start) / 1000) : 0,
      count: s.count,
      userId: s.userId
    }))

    res.json(formattedSessions)
  } catch (e) {
    console.error('analytics sessions error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

router.get('/users/:userId/events', async (req, res) => {
  try {
    const { type, limit = 200 } = req.query
    const { userId } = req.params
    
    const q = { userId }
    if (type) q.type = type

    const items = await findEvents(q, { sort: { ts: -1 }, limit: Math.min(Number(limit), 500), lean: true })
    res.json(items)
  } catch (e) {
    console.error('analytics events error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

router.get('/users/:userId/overview', async (req, res) => {
  try {
    const { userId } = req.params
    const match = { user_id: userId }

    const overviewPipe = [
      { $match: match },
      {
        $facet: {
          totalEvents: [{ $count: 'count' }],
          eventTypes: [{ $group: { _id: '$event_type', count: { $sum: 1 } } }],
          sessions: [
            {
              $group: {
                _id: { $ifNull: ['$session_id', '$page_id'] },
                start: { $min: { $toDate: '$ts' } },
                end: { $max: { $toDate: '$ts' } }
              }
            }
          ]
        }
      }
    ]
    const allOvRes = await Promise.all(getAllModels().map(M => M.aggregate(overviewPipe).allowDiskUse(true)))

    let totalEvents = 0
    const byType = {}
    const sessMap = new Map()
    for (const [r] of allOvRes) {
      if (!r) continue
      totalEvents += r.totalEvents?.[0]?.count || 0
      ;(r.eventTypes || []).forEach(et => { if (et._id) byType[et._id] = (byType[et._id] || 0) + et.count })
      ;(r.sessions || []).forEach(s => {
        const ex = sessMap.get(s._id)
        if (ex) { ex.start = Math.min(ex.start, s.start); ex.end = Math.max(ex.end, s.end) }
        else sessMap.set(s._id, { ...s })
      })
    }

    const screenshots = await ActivityLog.countDocuments({ ...match, event_type: 'screenshot' })
    const sessions = [...sessMap.values()]
    const totalSessions = sessions.filter(s => s.end > s.start).length

    const avgDuration = sessions.length > 0
      ? sessions.reduce((sum, s) => sum + ((s.end && s.start ? (s.end - s.start) / 1000 : 0)), 0) / sessions.length
      : 0

    res.json({
      totalSessions,
      totalEvents,
      screenshots,
      avgTimeSec: Math.round(avgDuration),
      byType
    })
  } catch (e) {
    console.error('analytics overview error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

// Admin global overview
router.get('/admin/overview', async (req, res) => {
  try {
    const cacheKey = 'admin_overview'
    const cached = getCached(cacheKey)
    if (cached) return res.json(cached)

    const matchExtensionEvents = { user_id: { $exists: true, $ne: null } }

    const adminPipe = [
      { $match: matchExtensionEvents },
      {
        $facet: {
          totalEvents: [{ $count: 'count' }],
          eventTypes: [{ $group: { _id: '$event_type', count: { $sum: 1 } } }],
          sessions: [
            {
              $group: {
                _id: { $ifNull: ['$session_id', '$page_id'] },
                start: { $min: { $toDate: '$ts' } },
                end: { $max: { $toDate: '$ts' } }
              }
            }
          ]
        }
      }
    ]

    const [allAdminResults, totalUsers] = await Promise.all([
      Promise.all(getAllModels().map(M => M.aggregate(adminPipe).allowDiskUse(true))),
      ExtensionUser.countDocuments()
    ])

    let totalEvents = 0
    const byType = {}
    const sessMap = new Map()
    for (const [r] of allAdminResults) {
      if (!r) continue
      totalEvents += r.totalEvents?.[0]?.count || 0
      ;(r.eventTypes || []).forEach(et => { if (et._id) byType[et._id] = (byType[et._id] || 0) + et.count })
      ;(r.sessions || []).forEach(s => {
        const ex = sessMap.get(s._id)
        if (ex) { ex.start = Math.min(ex.start, s.start); ex.end = Math.max(ex.end, s.end) }
        else sessMap.set(s._id, { ...s })
      })
    }

    // Sort byType by count descending and take top 10
    const sortedByType = {}
    Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => { sortedByType[k] = v })

    const sessions = [...sessMap.values()].filter(s => s.end > s.start)
    const totalSessions = sessions.length

    const avgDuration = sessions.length > 0
      ? sessions.reduce((sum, s) => sum + ((s.end - s.start) / 1000 || 0), 0) / sessions.length
      : 0

    const response = {
      totalUsers,
      totalSessions,
      totalEvents,
      avgSessionDurationSec: Math.round(avgDuration),
      byType: sortedByType,
      sessionsOverTime: [] // TODO: implement cross-collection sessionsOverTime if needed
    }

    setCache(cacheKey, response)
    res.json(response)
  } catch (e) {
    console.error('admin overview error:', e)
    res.status(500).json({ error: 'analytics error', details: e.message })
  }
})

export default router
