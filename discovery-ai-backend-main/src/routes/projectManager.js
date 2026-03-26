import { Router } from 'express'
import { Readable } from 'stream'
import ExtensionUser from '../models/ExtensionUser.js'
import User from '../models/User.js'
import ActivityLog from '../models/ActivityLog.js'
import ScreenshotRecord from '../models/ScreenshotRecord.js'
import TeamInvitation from '../models/TeamInvitation.js'
import { verifyToken, hashPassword } from '../utils/auth.js'
import {
  findEvents,
  countEvents,
  getAllModels
} from '../services/eventStore.js'
import OcrClaim from '../models/OcrClaim.js'
import { getClaimsExcelBuffer } from '../services/claimExportService.js'
import { mergeClaims } from '../services/tagsEngine/claimMerger.js'
import { getScreenshotImageUrlFromData } from '../utils/screenshotImageUrl.js'

const router = Router()

// Simple in-memory cache with per-key TTL
const cache = new Map()
const CACHE_TTL = 30 * 1000
const CACHE_TTL_LONG = 60 * 1000

function getCached(key) {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > (entry.ttl || CACHE_TTL)) {
    cache.delete(key)
    return null
  }
  return entry.data
}

function setCache(key, data, ttl) {
  cache.set(key, { data, ts: Date.now(), ttl: ttl || CACHE_TTL })
  if (cache.size > 200) {
    const now = Date.now()
    for (const [k, v] of cache) {
      if (now - v.ts > (v.ttl || CACHE_TTL)) cache.delete(k)
    }
  }
}

function invalidatePrefix(prefix) {
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k)
  }
}

// Middleware to verify user is a project manager and get their projectId
async function requireProjectManager(req, res, next) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  
  try {
    const payload = verifyToken(token)
    const user = await User.findById(payload.sub)
    if (!user) return res.status(401).json({ error: 'User not found' })
    
    // Check if user is project_manager or admin (admin can access all)
    if (user.role !== 'project_manager' && user.role !== 'admin' && !user.isAdmin) {
      return res.status(403).json({ error: 'Access denied. Project Manager role required.' })
    }
    
    req.user = user
    req.userId = payload.sub
    req.projectId = user.projectId
    req.isAdmin = user.role === 'admin' || user.isAdmin
    next()
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}

// Apply middleware to all routes
router.use(requireProjectManager)

// ===== TEAM MEMBERS (Extension Users) MANAGEMENT =====

// Get all team members (extension users) in the project
router.get('/team', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    
    // Admin sees all, project manager sees only their project
    const query = isAdmin ? {} : { projectId }
    
    const teamMembers = await ExtensionUser.find(query)
      .select('_id username email name trackerUserId projectId isActive createdAt updatedAt')
      .sort({ createdAt: -1 })
      .lean()
    
    // Enrich with event counts across all organized collections
    const enrichedMembers = await Promise.all(teamMembers.map(async (member) => {
      const eventCount = await countEvents({ userId: member.trackerUserId })
      const [lastEvent] = await findEvents(
        { userId: member.trackerUserId },
        { select: 'ts', sort: { ts: -1 }, limit: 1, lean: true }
      )
      
      return {
        ...member,
        events: eventCount,
        lastActive: lastEvent?.ts || null
      }
    }))
    
    res.json(enrichedMembers)
  } catch (e) {
    console.error('[pm/team] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Create new team member
router.post('/team', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    const { username, password, email, name } = req.body
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' })
    }
    
    // Check if username already exists
    const existing = await ExtensionUser.findOne({ username })
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' })
    }

    const emailLower = (email || '').trim().toLowerCase()
    if (emailLower.includes('@')) {
      const emailTaken = await ExtensionUser.findOne({ email: emailLower })
      if (emailTaken) {
        return res.status(409).json({ error: 'Email already registered' })
      }
    }
    
    const passwordHash = await hashPassword(password)
    
    // Generate a unique trackerUserId for the new user
    const trackerUserId = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    
    const newMember = await ExtensionUser.create({
      username,
      passwordHash,
      email: emailLower.includes('@') ? emailLower : email || null,
      name: name || username,
      trackerUserId,
      projectId: req.body.projectId || projectId, // Admin can specify project, PM uses their own
      isActive: true
    })
    
    res.json({
      success: true,
      member: {
        _id: newMember._id,
        username: newMember.username,
        email: newMember.email,
        name: newMember.name,
        trackerUserId: newMember.trackerUserId,
        projectId: newMember.projectId,
        isActive: newMember.isActive,
        createdAt: newMember.createdAt
      }
    })
  } catch (e) {
    console.error('[pm/team] Create error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Update team member
router.put('/team/:memberId', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    const { memberId } = req.params
    const { username, password, email, name, isActive } = req.body
    
    // Find the member
    const member = await ExtensionUser.findById(memberId)
    if (!member) {
      return res.status(404).json({ error: 'Team member not found' })
    }
    
    // Check if PM can edit this member (same project)
    if (!isAdmin && member.projectId !== projectId) {
      return res.status(403).json({ error: 'Access denied. Cannot edit users from other projects.' })
    }
    
    // Prepare update object
    const update = {}
    if (username !== undefined) {
      // Check if new username already exists
      const existing = await ExtensionUser.findOne({ username, _id: { $ne: memberId } })
      if (existing) {
        return res.status(409).json({ error: 'Username already exists' })
      }
      update.username = username
    }
    if (password) {
      update.passwordHash = await hashPassword(password)
    }
    if (email !== undefined) {
      const em = String(email).trim().toLowerCase()
      if (em && em.includes('@')) {
        const taken = await ExtensionUser.findOne({ email: em, _id: { $ne: memberId } })
        if (taken) return res.status(409).json({ error: 'Email already registered' })
        update.email = em
      } else {
        update.email = null
      }
    }
    if (name !== undefined) update.name = name
    if (isActive !== undefined) update.isActive = isActive
    
    const updated = await ExtensionUser.findByIdAndUpdate(memberId, update, { new: true })
      .select('_id username email name trackerUserId projectId isActive createdAt updatedAt')
    
    res.json({
      success: true,
      member: updated
    })
  } catch (e) {
    console.error('[pm/team] Update error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Delete team member (remove from team, not delete the user)
router.delete('/team/:memberId', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    const { memberId } = req.params
    
    // Find the member
    const member = await ExtensionUser.findById(memberId)
    if (!member) {
      return res.status(404).json({ error: 'Team member not found' })
    }
    
    // Check if PM can remove this member (same project)
    if (!isAdmin && member.projectId !== projectId) {
      return res.status(403).json({ error: 'Access denied. Cannot remove users from other projects.' })
    }
    
    // Remove from team by clearing projectId (don't delete the user)
    await ExtensionUser.findByIdAndUpdate(memberId, { $unset: { projectId: 1 } })
    
    res.json({ success: true, message: 'Team member removed from team' })
  } catch (e) {
    console.error('[pm/team] Delete error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// ===== TEAM INVITATIONS =====

// Search for extension user by email
router.get('/invitations/search', async (req, res) => {
  try {
    const { email } = req.query
    const { projectId } = req
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }
    
    // Search for extension user by email field OR by username (since many users register with email as username)
    const emailLower = email.toLowerCase()
    let extUser = await ExtensionUser.findOne({ email: emailLower })
      .select('_id username email name trackerUserId projectId isActive createdAt')
      .lean()
    
    // Fallback: search by username (extension users often have email as their username)
    if (!extUser) {
      extUser = await ExtensionUser.findOne({ username: emailLower })
        .select('_id username email name trackerUserId projectId isActive createdAt')
        .lean()
    }

    // Fallback: case-insensitive regex search on username
    if (!extUser) {
      extUser = await ExtensionUser.findOne({ username: { $regex: new RegExp(`^${emailLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') } })
        .select('_id username email name trackerUserId projectId isActive createdAt')
        .lean()
    }
    
    if (!extUser) {
      return res.json({ found: false, message: 'No user found with this email' })
    }
    
    // Check if already in this project
    if (extUser.projectId === projectId) {
      return res.json({ 
        found: true, 
        alreadyInTeam: true, 
        user: extUser,
        message: 'This user is already in your team' 
      })
    }
    
    // Check if already in another project
    if (extUser.projectId) {
      return res.json({ 
        found: true, 
        inOtherTeam: true, 
        user: { ...extUser, projectId: undefined }, // Don't reveal other project
        message: 'This user is already in another team' 
      })
    }
    
    // Check for pending invitation
    const pendingInvite = await TeamInvitation.findOne({
      extensionUserId: extUser._id,
      projectId,
      status: 'pending'
    })
    
    if (pendingInvite) {
      return res.json({ 
        found: true, 
        pendingInvite: true, 
        user: extUser,
        invitation: pendingInvite,
        message: 'An invitation is already pending for this user' 
      })
    }
    
    // Get user's event count across all collections
    const eventCount = await countEvents({ userId: extUser.trackerUserId })
    
    res.json({ 
      found: true, 
      canInvite: true, 
      user: { ...extUser, events: eventCount },
      message: 'User found and can be invited' 
    })
  } catch (e) {
    console.error('[pm/invitations/search] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Send invitation to join team
router.post('/invitations', async (req, res) => {
  try {
    const { user, projectId } = req
    const { extensionUserId, email, message } = req.body
    
    if (!extensionUserId || !email) {
      return res.status(400).json({ error: 'Extension user ID and email are required' })
    }
    
    // Verify the extension user exists
    const extUser = await ExtensionUser.findById(extensionUserId)
    if (!extUser) {
      return res.status(404).json({ error: 'User not found' })
    }
    
    // Check if already in a team
    if (extUser.projectId) {
      return res.status(400).json({ error: 'User is already in a team' })
    }
    
    // Check for existing pending invitation
    const existing = await TeamInvitation.findOne({
      extensionUserId,
      projectId,
      status: 'pending'
    })
    
    if (existing) {
      return res.status(409).json({ error: 'Invitation already pending for this user' })
    }
    
    // Create invitation
    const invitation = await TeamInvitation.create({
      extensionUserId,
      email: email.toLowerCase(),
      projectId,
      invitedBy: user._id,
      invitedByName: user.name,
      invitedByEmail: user.email,
      message: message || null,
      status: 'pending'
    })
    
    res.json({
      success: true,
      invitation: {
        _id: invitation._id,
        email: invitation.email,
        projectId: invitation.projectId,
        status: invitation.status,
        createdAt: invitation.createdAt
      }
    })
  } catch (e) {
    console.error('[pm/invitations] Create error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Get all pending invitations for this project
router.get('/invitations', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    
    const query = isAdmin ? {} : { projectId }
    
    const invitations = await TeamInvitation.find(query)
      .populate('extensionUserId', 'username email name trackerUserId')
      .sort({ createdAt: -1 })
      .lean()
    
    res.json(invitations)
  } catch (e) {
    console.error('[pm/invitations] List error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Cancel an invitation
router.delete('/invitations/:invitationId', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    const { invitationId } = req.params
    
    const invitation = await TeamInvitation.findById(invitationId)
    if (!invitation) {
      return res.status(404).json({ error: 'Invitation not found' })
    }
    
    // Check if PM can cancel this invitation
    if (!isAdmin && invitation.projectId !== projectId) {
      return res.status(403).json({ error: 'Access denied' })
    }
    
    if (invitation.status !== 'pending') {
      return res.status(400).json({ error: 'Can only cancel pending invitations' })
    }
    
    invitation.status = 'cancelled'
    await invitation.save()
    
    res.json({ success: true, message: 'Invitation cancelled' })
  } catch (e) {
    console.error('[pm/invitations] Cancel error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// ===== ANALYTICS - PROJECT SCOPED =====

// Get overview for the project
router.get('/overview', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    
    // Get all team members' trackerUserIds
    const teamQuery = isAdmin ? {} : { projectId }
    const teamMembers = await ExtensionUser.find(teamQuery).select('trackerUserId').lean()
    const userIds = teamMembers.map(m => m.trackerUserId)
    
    if (userIds.length === 0) {
      return res.json({
        totalUsers: 0,
        totalSessions: 0,
        totalEvents: 0,
        avgSessionDurationSec: 0,
        screenshots: 0
      })
    }
    
    const cacheKey = `pm_overview_${projectId || 'all'}`
    const cached = getCached(cacheKey)
    if (cached) return res.json(cached)
    
    // Aggregate overview across all organized event collections
    const matchQ = { user_id: { $in: userIds } }
    const overviewPipe = [
      { $match: matchQ },
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
    const allResults = await Promise.all(getAllModels().map(M => M.aggregate(overviewPipe).allowDiskUse(true)))

    let totalEvents = 0
    const byType = {}
    const sessMap = new Map()
    for (const [r] of allResults) {
      if (!r) continue
      totalEvents += r.totalEvents?.[0]?.count || 0
      ;(r.eventTypes || []).forEach(et => { if (et._id) byType[et._id] = (byType[et._id] || 0) + et.count })
      ;(r.sessions || []).forEach(s => {
        const ex = sessMap.get(s._id)
        if (ex) { ex.start = Math.min(ex.start, s.start); ex.end = Math.max(ex.end, s.end) }
        else sessMap.set(s._id, { ...s })
      })
    }

    const screenshots = await ActivityLog.countDocuments({ ...matchQ, event_type: 'screenshot' })
    const sessions = [...sessMap.values()].filter(s => s.end > s.start)
    const totalSessions = sessions.length
    
    const avgDuration = sessions.length > 0
      ? sessions.reduce((sum, s) => sum + ((s.end - s.start) / 1000 || 0), 0) / sessions.length
      : 0
    
    const response = {
      totalUsers: userIds.length,
      totalSessions,
      totalEvents,
      avgSessionDurationSec: Math.round(avgDuration),
      screenshots,
      byType
    }
    
    setCache(cacheKey, response)
    res.json(response)
  } catch (e) {
    console.error('[pm/overview] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Get users with analytics
router.get('/users', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    const { limit = 200 } = req.query
    
    // Get team members
    const teamQuery = isAdmin ? {} : { projectId }
    const teamMembers = await ExtensionUser.find(teamQuery)
      .select('_id username email name trackerUserId projectId isActive')
      .lean()
    
    const userIds = teamMembers.map(m => m.trackerUserId)
    
    if (userIds.length === 0) {
      return res.json([])
    }
    
    // Get event stats per user across all collections
    const userStatsPipe = [
      { $match: { user_id: { $in: userIds } } },
      {
        $group: {
          _id: '$user_id',
          events: { $sum: 1 },
          firstTs: { $min: { $toDate: '$ts' } },
          lastTs: { $max: { $toDate: '$ts' } }
        }
      }
    ]
    const allUserStatResults = await Promise.all(getAllModels().map(M => M.aggregate(userStatsPipe).allowDiskUse(true)))
    
    // Merge user stats from all collections
    const statsMap = new Map()
    for (const results of allUserStatResults) {
      for (const u of results) {
        const existing = statsMap.get(u._id)
        if (existing) {
          existing.events += u.events
          existing.firstTs = Math.min(existing.firstTs || Infinity, u.firstTs || Infinity)
          existing.lastTs = Math.max(existing.lastTs || 0, u.lastTs || 0)
        } else {
          statsMap.set(u._id, { ...u })
        }
      }
    }
    
    // Merge team member info with stats
    const result = teamMembers.map(member => {
      const stats = statsMap.get(member.trackerUserId) || { events: 0, firstTs: null, lastTs: null }
      return {
        userId: member.trackerUserId,
        _id: member._id,
        username: member.username,
        email: member.email,
        name: member.name,
        projectId: member.projectId,
        isActive: member.isActive,
        events: stats.events,
        firstTs: stats.firstTs,
        lastTs: stats.lastTs
      }
    }).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
    
    res.json(result)
  } catch (e) {
    console.error('[pm/users] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Get sessions for a specific user
router.get('/users/:userId/sessions', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    const { userId } = req.params
    const { limit = 100 } = req.query
    
    // Verify the user belongs to this project (if not admin)
    if (!isAdmin) {
      const member = await ExtensionUser.findOne({ trackerUserId: userId, projectId })
      if (!member) {
        return res.status(403).json({ error: 'Access denied. User not in your project.' })
      }
    }
    
    // Aggregate sessions across all event collections
    const sPipe = [
      { $match: { userId } },
      { $group: { _id: { $ifNull: ['$sessionId', '$pageId'] }, start: { $min: '$ts' }, end: { $max: '$ts' }, count: { $sum: 1 }, userId: { $first: '$userId' } } }
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
    console.error('[pm/users/sessions] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Get events for a specific user
router.get('/users/:userId/events', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    const { userId } = req.params
    const { type, sessionId, limit = 200 } = req.query
    
    // Verify the user belongs to this project (if not admin)
    if (!isAdmin) {
      const member = await ExtensionUser.findOne({ trackerUserId: userId, projectId })
      if (!member) {
        return res.status(403).json({ error: 'Access denied. User not in your project.' })
      }
    }
    
    const q = { userId }
    if (type) q.type = type
    if (sessionId) q.sessionId = sessionId
    
    const items = await findEvents(q, { sort: { ts: -1 }, limit: Math.min(Number(limit), 500), lean: true })
    
    res.json(items)
  } catch (e) {
    console.error('[pm/users/events] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Get overview for a specific user
router.get('/users/:userId/overview', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    const { userId } = req.params
    
    // Verify the user belongs to this project (if not admin)
    if (!isAdmin) {
      const member = await ExtensionUser.findOne({ trackerUserId: userId, projectId })
      if (!member) {
        return res.status(403).json({ error: 'Access denied. User not in your project.' })
      }
    }
    
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
    console.error('[pm/users/overview] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Get all sessions for the project
router.get('/sessions', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    const { limit = 100 } = req.query
    
    // Get team members' userIds
    const teamQuery = isAdmin ? {} : { projectId }
    const teamMembers = await ExtensionUser.find(teamQuery).select('trackerUserId').lean()
    const userIds = teamMembers.map(m => m.trackerUserId)
    
    if (userIds.length === 0) {
      return res.json([])
    }
    
    // Aggregate sessions across all event collections
    const sPipe = [
      { $match: { user_id: { $in: userIds } } },
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
    console.error('[pm/sessions] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Get all screenshots for the project
router.get('/screenshots', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    const { limit = 50 } = req.query
    const maxLimit = Math.min(Number(limit), 200)

    const cacheKey = `screenshots_${projectId || 'admin'}_${maxLimit}`
    const cached = getCached(cacheKey)
    if (cached) return res.json(cached)
    
    // Get team members' userIds
    const teamQuery = isAdmin ? {} : { projectId }
    const teamMembers = await ExtensionUser.find(teamQuery).select('trackerUserId').lean()
    const userIds = teamMembers.map(m => m.trackerUserId)
    
    if (userIds.length === 0) {
      return res.json([])
    }
    
    // Project BEFORE sort so the sort operates on lightweight documents (excludes huge data/image fields)
    // This keeps the sort well under MongoDB's 32MB in-memory limit on shared-tier clusters
    const items = await ActivityLog.aggregate([
      { $match: { user_id: { $in: userIds }, event_type: 'screenshot' } },
      {
        $project: {
          ts: 1,
          session_id: 1,
          page_id: 1,
          user_id: 1,
          project_id: 1,
          event_type: 1,
          ip: 1,
          details: 1
        }
      },
      { $sort: { ts: -1 } },
      { $limit: maxLimit }
    ])
    
    setCache(cacheKey, items)
    res.json(items)
  } catch (e) {
    console.error('[pm/screenshots] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Serve screenshot image by event ID (proxy for PM UI — fixes "unavailable" when blob CORS or dataUrl not in list)
router.get('/screenshots/:eventId/image', async (req, res) => {
  try {
    const { eventId } = req.params
    const { projectId, isAdmin } = req

    const teamQuery = isAdmin ? {} : { projectId }
    const teamMembers = await ExtensionUser.find(teamQuery).select('trackerUserId').lean()
    const userIds = teamMembers.map(m => m.trackerUserId)
    if (userIds.length === 0) {
      return res.status(404).json({ error: 'Not found' })
    }

    const shot = await ScreenshotRecord.findOne({
      $or: [{ _id: eventId }, { legacy_event_id: eventId }],
      user_id: { $in: userIds }
    })
      .lean()

    if (!shot || !shot.screenshot_url) {
      return res.status(404).json({ error: 'Screenshot not found' })
    }

    const d = { imageUrl: shot.screenshot_url }
    const remoteImage = getScreenshotImageUrlFromData(d)
    if (remoteImage) {
      try {
        const imgRes = await fetch(remoteImage, { signal: AbortSignal.timeout(15000) })
        if (imgRes.ok && imgRes.body) {
          res.setHeader('Content-Type', imgRes.headers.get('content-type') || 'image/png')
          res.setHeader('Cache-Control', 'private, max-age=3600')
          Readable.fromWeb(imgRes.body).pipe(res)
          return
        }
      } catch (fetchErr) {
        console.warn('[pm/screenshots/image] Remote image fetch failed:', fetchErr.message)
      }
      return res.redirect(302, remoteImage)
    }
    if (d.dataUrl && typeof d.dataUrl === 'string') {
      const match = d.dataUrl.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        const contentType = (match[1] || 'image/png').trim()
        const buf = Buffer.from(match[2], 'base64')
        res.setHeader('Content-Type', contentType)
        res.setHeader('Cache-Control', 'private, max-age=3600')
        return res.send(buf)
      }
    }
    return res.status(404).json({ error: 'No image data' })
  } catch (e) {
    console.error('[pm/screenshots/:eventId/image] Error:', e)
    res.status(500).json({ error: 'Server error' })
  }
})

// Get all events for the project
router.get('/events', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    const { type, limit = 200 } = req.query
    
    // Get team members' userIds
    const teamQuery = isAdmin ? {} : { projectId }
    const teamMembers = await ExtensionUser.find(teamQuery).select('trackerUserId').lean()
    const userIds = teamMembers.map(m => m.trackerUserId)
    
    if (userIds.length === 0) {
      return res.json([])
    }
    
    const q = { userId: { $in: userIds } }
    if (type) q.type = type
    
    const items = await findEvents(q, {
      select: 'ts sessionId pageId userId projectId type data ip tabId url title',
      sort: { ts: -1 },
      limit: Math.min(Number(limit), 2000),
      lean: true
    })
    
    res.json(items)
  } catch (e) {
    console.error('[pm/events] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// ===== CLAIMS (OCR-derived) =====

// Helper: get image URL from screenshot event data (for display in frontend)
function getScreenshotImageUrl(ev) {
  if (!ev || !ev.data) return null
  const d = ev.data
  const remote = getScreenshotImageUrlFromData(d)
  if (remote) return remote
  if (d.dataUrl) return typeof d.dataUrl === 'string' ? d.dataUrl : null
  if (d.url && typeof d.url === 'string' && d.url.startsWith('data:image')) return d.url
  return null
}

// List claims for the current project (PM scope); enrich with user email
router.get('/claims', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    const { limit = 300 } = req.query
    const maxLimit = Math.min(Number(limit) || 300, 1000)

    const cacheKey = `claims_${projectId || 'admin'}_${maxLimit}`
    const cached = getCached(cacheKey)
    if (cached) return res.json(cached)

    const query = {}
    if (!isAdmin && projectId) {
      query.projectId = projectId
    }

    const claims = await OcrClaim.find(query)
      .select('-ocrText -ocrTags')
      .sort({ firstSeenTs: -1, updatedAt: -1 })
      .limit(maxLimit)
      .lean()

    const trackerUserIds = [...new Set(claims.map(c => c.trackerUserId).filter(Boolean))]
    const extUsers = trackerUserIds.length > 0
      ? await ExtensionUser.find({ trackerUserId: { $in: trackerUserIds } })
          .select('_id trackerUserId email name username').lean()
      : []
    const userByTracker = new Map()
    for (const u of extUsers) {
      const info = { userEmail: u.email || u.username || '', userName: u.name || u.username || '' }
      if (u.trackerUserId) userByTracker.set(u.trackerUserId, info)
    }

    const enriched = claims.map(c => {
      const userInfo = c.trackerUserId ? userByTracker.get(c.trackerUserId) : null
      const email = userInfo?.userEmail ?? ''
      return {
        ...c,
        imageUrl: null,
        userEmail: email,
        userName: userInfo?.userName ?? '',
        assignedTo: c.assignedTo || email
      }
    })
    setCache(cacheKey, enriched)
    res.json(enriched)
  } catch (e) {
    console.error('[pm/claims] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Simple analytics summary for claims (by status/type/provider)
// IMPORTANT: This must come BEFORE /claims/:claimId to avoid route conflicts
router.get('/claims/analytics', async (req, res) => {
  try {
    const { projectId, isAdmin } = req

    const cacheKey = `claims_analytics_${projectId || 'admin'}`
    const cached = getCached(cacheKey)
    if (cached) return res.json(cached)

    const match = {}
    if (!isAdmin && projectId) {
      match.projectId = projectId
    }

    const pipeline = [
      { $match: match },
      {
        $facet: {
          byStatus: [
            { $group: { _id: '$status', count: { $sum: 1 } } }
          ],
          byType: [
            { $group: { _id: '$claimType', count: { $sum: 1 } } }
          ],
          byProvider: [
            { $group: { _id: '$providerName', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ],
          duration: [
            {
              $group: {
                _id: null,
                avgSec: { $avg: '$processingDurationSec' },
                maxSec: { $max: '$processingDurationSec' }
              }
            }
          ]
        }
      }
    ]

    const [agg] = await OcrClaim.aggregate(pipeline).allowDiskUse(true)

    const result = {
      byStatus: agg?.byStatus || [],
      byType: agg?.byType || [],
      byProvider: agg?.byProvider || [],
      duration: agg?.duration?.[0] || { avgSec: 0, maxSec: 0 }
    }
    setCache(cacheKey, result, CACHE_TTL_LONG)
    res.json(result)
  } catch (e) {
    console.error('[pm/claims/analytics] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Server-side OCR removed — no background image processing (keeps memory stable on Render free tier).
async function runReprocessJob(_projectId, _isAdmin, _limit = 500) {
  console.log('[pm/claims/reprocess] Skipped: OCR pipeline disabled on server')
  return { processed: 0, created: 0, updated: 0, skipped: 0, failed: 0, total: 0, ocrDisabled: true }
}

router.post('/claims/reprocess', (req, res) => {
  const { projectId, isAdmin } = req
  const limit = req.body?.limit ?? 500

  // Respond immediately so the request does not hit gateway timeout (avoids CORS error from proxy 504)
  res.status(202).json({
    success: true,
    message: 'Reprocess is a no-op: server-side OCR is disabled. Existing claims in DB are unchanged.',
    started: true,
    ocrDisabled: true
  })

  runReprocessJob(projectId, isAdmin, limit)
    .then((result) => {
      invalidatePrefix('claims_')
      console.log('[pm/claims/reprocess] Background job finished:', result)
    })
    .catch((e) => {
      console.error('[pm/claims/reprocess] Background job error:', e)
    })
})

// Export claims as CSV: respond with file download (same scope as GET /claims)
router.post('/claims/export', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    const query = !isAdmin && projectId ? { projectId } : {}
    const buffer = await getClaimsExcelBuffer(query)
    const filename = 'claims_export.xlsx'
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(Buffer.from(buffer))
  } catch (e) {
    console.error('[pm/claims/export] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Get detailed claim by ID (all available data, merged from all screens for this claim)
// Enriches screenshots with imageUrl from ScreenshotEvent for frontend display
const OBJECT_ID_REGEX = /^[a-f0-9]{24}$/i

router.get('/claims/:claimId', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    const { claimId } = req.params
    const baseQuery = !isAdmin && projectId ? { projectId } : {}

    // If param is a document _id (24 hex chars), return that single doc enriched (for reopen rows)
    if (OBJECT_ID_REGEX.test(claimId)) {
      const doc = await OcrClaim.findOne({ _id: claimId, ...baseQuery }).lean()
      if (!doc) {
        return res.status(404).json({ error: 'Claim not found' })
      }
      const events = await ActivityLog.find({ legacy_event_id: doc.screenshotEventId }).select('_id details user_id').limit(1).lean()
      const imageUrl = events.length ? getScreenshotImageUrl(events[0]) : null
      let userEmail = ''
      let userName = ''
      if (doc.trackerUserId) {
        const extUser = await ExtensionUser.findOne({ trackerUserId: doc.trackerUserId }).select('email name username').lean()
        if (extUser) {
          userEmail = extUser.email || ''
          userName = extUser.name || extUser.username || ''
        }
      }
      if (!userEmail && events.length && events[0].extensionUserId) {
        const extUser = await ExtensionUser.findById(events[0].extensionUserId).select('email name username').lean()
        if (extUser) {
          userEmail = extUser.email || ''
          userName = extUser.name || extUser.username || ''
        }
      }
      return res.json({
        ...doc,
        imageUrl,
        userEmail,
        userName,
        screenshots: doc.screenshotEventId ? [{ screenshotEventId: doc.screenshotEventId, imageUrl }] : []
      })
    }

    const allVariations = await OcrClaim.find({
      ...baseQuery,
      $or: [{ claimId }, { ediClaimId: claimId }]
    })
      .sort({ firstSeenTs: 1 })
      .lean()

    if (allVariations.length === 0) {
      return res.status(404).json({ error: 'Claim not found' })
    }

    const merged = mergeClaims(allVariations)
    merged.processingTimeline = allVariations.map(v => ({
      timestamp: v.firstSeenTs,
      docType: v.docType,
      origin: v.origin,
      sourceUrl: v.sourceUrl,
      isReopened: v.isReopened,
      reopenSequence: v.reopenSequence
    }))

    const eventIds = [...new Set(allVariations.map(v => v.screenshotEventId).filter(Boolean))]
    const events = eventIds.length > 0
      ? await ActivityLog.find({ legacy_event_id: { $in: eventIds } }).select('_id details user_id').lean()
      : []
    const urlByEventId = new Map(events.map(e => [e._id.toString(), getScreenshotImageUrl(e)]))

    if (merged.screenshots && merged.screenshots.length > 0) {
      merged.screenshots = merged.screenshots.map(s => ({
        ...s,
        imageUrl: s.screenshotEventId ? urlByEventId.get(s.screenshotEventId.toString()) || null : null
      }))
    }
    merged.imageUrl = merged.screenshots?.[0]?.imageUrl || urlByEventId.get((allVariations[0].screenshotEventId || {}).toString()) || null

    const trackerUserId = allVariations[0]?.trackerUserId
    if (trackerUserId) {
      const extUser = await ExtensionUser.findOne({ trackerUserId }).select('email name username').lean()
      if (extUser) {
        merged.userEmail = extUser.email || ''
        merged.userName = extUser.name || extUser.username || ''
      }
    }
    if (!merged.userEmail && events.length > 0) {
      const evWithUser = events.find(e => e.extensionUserId)
      if (evWithUser) {
        const extUser = await ExtensionUser.findById(evWithUser.extensionUserId).select('email name username').lean()
        if (extUser) {
          merged.userEmail = extUser.email || ''
          merged.userName = merged.userName || extUser.name || extUser.username || ''
        }
      }
    }

    res.json(merged)
  } catch (e) {
    console.error('[pm/claims/:claimId] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// ===== REMOTE STEALTH CONTROL =====

// Send a remote command to a specific extension user
router.post('/remote-command', async (req, res) => {
  try {
    const { projectId, isAdmin, user } = req
    const { trackerUserId, command, sessionName } = req.body

    if (!trackerUserId || !command) {
      return res.status(400).json({ error: 'trackerUserId and command are required' })
    }

    const validCommands = ['start_session', 'end_session', 'pause_session', 'resume_session']
    if (!validCommands.includes(command)) {
      return res.status(400).json({ error: `Invalid command. Must be one of: ${validCommands.join(', ')}` })
    }

    // Verify the target user belongs to this project (if not admin)
    const extUser = await ExtensionUser.findOne({ trackerUserId })
    if (!extUser) {
      return res.status(404).json({ error: 'Extension user not found' })
    }
    // Allow if admin, or user is in PM's project, or user has no project yet
    if (!isAdmin && extUser.projectId && extUser.projectId !== projectId) {
      return res.status(403).json({ error: 'Access denied. User not in your project.' })
    }

    await ExtensionUser.updateMany(
      { trackerUserId },
      { $set: { 'remoteCommands.$[elem].status': 'cancelled' } },
      { arrayFilters: [{ 'elem.status': 'pending' }] }
    )

    const updated = await ExtensionUser.findByIdAndUpdate(
      extUser._id,
      {
        $push: {
          remoteCommands: {
            command,
            sessionName: sessionName || '',
            status: 'pending',
            issuedBy: user._id,
            expiresAt: new Date(Date.now() + 5 * 60 * 1000)
          }
        }
      },
      { new: true }
    )
    const remoteCmd = updated.remoteCommands[updated.remoteCommands.length - 1]

    // Update stealth tracking state on the extension user
    if (command === 'start_session') {
      await ExtensionUser.findByIdAndUpdate(extUser._id, {
        stealthTracking: true,
        stealthSessionName: sessionName || 'Remote Session',
        stealthStartedAt: new Date()
      })
    } else if (command === 'end_session') {
      await ExtensionUser.findByIdAndUpdate(extUser._id, {
        stealthTracking: false,
        stealthSessionName: '',
        stealthStartedAt: null
      })
    }

    console.log(`[remote-command] ${user.email} sent "${command}" to ${trackerUserId}`)

    res.json({
      success: true,
      command: {
        _id: remoteCmd._id,
        trackerUserId: remoteCmd.trackerUserId,
        command: remoteCmd.command,
        sessionName: remoteCmd.sessionName,
        status: remoteCmd.status,
        createdAt: remoteCmd.createdAt,
        expiresAt: remoteCmd.expiresAt
      }
    })
  } catch (e) {
    console.error('[pm/remote-command] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Get stealth tracking status for a specific user
router.get('/remote-status/:trackerUserId', async (req, res) => {
  try {
    const { projectId, isAdmin } = req
    const { trackerUserId } = req.params

    const extUser = await ExtensionUser.findOne({ trackerUserId })
      .select('trackerUserId projectId stealthTracking stealthSessionName stealthStartedAt isActive')
      .lean()

    if (!extUser) {
      return res.status(404).json({ error: 'Extension user not found' })
    }
    // Allow access if admin, or if user is in PM's project, or if user has no project yet
    if (!isAdmin && extUser.projectId && extUser.projectId !== projectId) {
      return res.status(403).json({ error: 'Access denied' })
    }

    const full = await ExtensionUser.findOne({ trackerUserId }).select('remoteCommands').lean()
    const recentCommands = (full?.remoteCommands || [])
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, 10)

    res.json({
      trackerUserId: extUser.trackerUserId,
      stealthTracking: extUser.stealthTracking || false,
      stealthSessionName: extUser.stealthSessionName || '',
      stealthStartedAt: extUser.stealthStartedAt || null,
      recentCommands
    })
  } catch (e) {
    console.error('[pm/remote-status] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

// Bulk remote command - send command to multiple users at once
router.post('/remote-command/bulk', async (req, res) => {
  try {
    const { projectId, isAdmin, user } = req
    const { trackerUserIds, command, sessionName } = req.body

    if (!trackerUserIds || !Array.isArray(trackerUserIds) || trackerUserIds.length === 0) {
      return res.status(400).json({ error: 'trackerUserIds array is required' })
    }
    if (!command) {
      return res.status(400).json({ error: 'command is required' })
    }

    const validCommands = ['start_session', 'end_session', 'pause_session', 'resume_session']
    if (!validCommands.includes(command)) {
      return res.status(400).json({ error: `Invalid command. Must be one of: ${validCommands.join(', ')}` })
    }

    // Verify all users belong to this project
    const query = isAdmin
      ? { trackerUserId: { $in: trackerUserIds } }
      : { trackerUserId: { $in: trackerUserIds }, projectId }
    const extUsers = await ExtensionUser.find(query).lean()

    const validUserIds = extUsers.map(u => u.trackerUserId)

    await ExtensionUser.updateMany(
      { trackerUserId: { $in: validUserIds } },
      { $set: { 'remoteCommands.$[elem].status': 'cancelled' } },
      { arrayFilters: [{ 'elem.status': 'pending' }] }
    )

    const inserted = []
    for (const tid of validUserIds) {
      const eu = extUsers.find(u => u.trackerUserId === tid)
      if (!eu) continue
      const upd = await ExtensionUser.findByIdAndUpdate(
        eu._id,
        {
          $push: {
            remoteCommands: {
              command,
              sessionName: sessionName || '',
              status: 'pending',
              issuedBy: user._id,
              expiresAt: new Date(Date.now() + 5 * 60 * 1000)
            }
          }
        },
        { new: true }
      )
      const rc = upd.remoteCommands[upd.remoteCommands.length - 1]
      inserted.push({ _id: rc._id, trackerUserId: tid, command, status: rc.status })
    }

    // Update stealth tracking state
    if (command === 'start_session') {
      await ExtensionUser.updateMany(
        { trackerUserId: { $in: validUserIds } },
        { stealthTracking: true, stealthSessionName: sessionName || 'Remote Session', stealthStartedAt: new Date() }
      )
    } else if (command === 'end_session') {
      await ExtensionUser.updateMany(
        { trackerUserId: { $in: validUserIds } },
        { stealthTracking: false, stealthSessionName: '', stealthStartedAt: null }
      )
    }

    console.log(`[remote-command/bulk] ${user.email} sent "${command}" to ${validUserIds.length} users`)

    res.json({
      success: true,
      sent: inserted.length,
      skipped: trackerUserIds.length - validUserIds.length,
      commands: inserted.map(c => ({
        _id: c._id,
        trackerUserId: c.trackerUserId,
        command: c.command,
        status: c.status
      }))
    })
  } catch (e) {
    console.error('[pm/remote-command/bulk] Error:', e)
    res.status(500).json({ error: 'Server error', details: e.message })
  }
})

export default router
