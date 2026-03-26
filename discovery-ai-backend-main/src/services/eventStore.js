/**
 * Event queries — backed only by `logs` (ActivityLog). No per-type event collections.
 */

import ActivityLog from '../models/ActivityLog.js'
import { getCategoryForType, EVENT_CATEGORIES as EVENT_CATEGORIES_CONST } from '../constants/eventCategories.js'

export { EVENT_CATEGORIES_CONST as EVENT_CATEGORIES }

function mapQuery(q) {
  if (!q || typeof q !== 'object') return {}
  const out = { ...q }
  if (q.userId != null) {
    out.user_id = q.userId
    delete out.userId
  }
  if (q.type != null) {
    out.event_type = q.type
    delete out.type
  }
  if (q.sessionId != null) {
    out.session_id = q.sessionId
    delete out.sessionId
  }
  if (q.pageId != null) {
    out.page_id = q.pageId
    delete out.pageId
  }
  if (q.projectId != null) {
    out.project_id = q.projectId
  }
  return out
}

function parseDetails(details) {
  try {
    const j = JSON.parse(details || '{}')
    return j.web || j
  } catch {
    return {}
  }
}

/** Shape similar to legacy event docs for API compatibility */
export function logDocToLegacyEvent(doc) {
  if (!doc) return null
  const tsMs = typeof doc.ts === 'string' ? Date.parse(doc.ts) : Number(doc.ts)
  const data = parseDetails(doc.details)
  return {
    _id: doc.legacy_event_id || doc._id,
    ts: Number.isFinite(tsMs) ? tsMs : Date.now(),
    type: doc.event_type,
    userId: doc.user_id,
    sessionId: doc.session_id || undefined,
    pageId: doc.page_id || undefined,
    projectId: doc.project_id || undefined,
    data,
    ip: doc.ip,
    category: doc.category_key
  }
}

export async function insertEvents(_docs) {
  console.warn('[eventStore] insertEvents is deprecated — events go to logs via /api/collect only')
  return []
}

export async function insertEvent(_doc) {
  console.warn('[eventStore] insertEvent is deprecated')
  return null
}

function mapSelect(sel) {
  if (!sel) return sel
  return sel
    .split(/\s+/)
    .filter(Boolean)
    .map((f) =>
      ({
        userId: 'user_id',
        sessionId: 'session_id',
        pageId: 'page_id',
        projectId: 'project_id',
        type: 'event_type'
      }[f] || f)
    )
    .join(' ')
}

export async function findEvents(query = {}, options = {}) {
  const { select, sort = { ts: -1 }, limit = 200, lean = true } = options
  const mongoQ = mapQuery(query)
  let q = ActivityLog.find(mongoQ)
  if (select) q = q.select(mapSelect(select))
  const sortKey = Object.keys(sort)[0] || 'ts'
  const sortDir = sort[sortKey] === -1 ? -1 : 1
  const mongoSort = {}
  if (sortKey === 'ts') mongoSort.ts = sortDir
  else mongoSort[sortKey] = sortDir
  q = q.sort(mongoSort).limit(limit).setOptions({ allowDiskUse: true })
  if (lean) q = q.lean()
  const rows = await q
  return rows.map(logDocToLegacyEvent)
}

export async function countEvents(query = {}) {
  return ActivityLog.countDocuments(mapQuery(query))
}

export async function distinctEvents(field, query = {}) {
  const f =
    field === 'userId'
      ? 'user_id'
      : field === 'type'
        ? 'event_type'
        : field === 'sessionId'
          ? 'session_id'
          : field === 'pageId'
            ? 'page_id'
            : field
  return ActivityLog.distinct(f, mapQuery(query))
}

export async function aggregateAll(pipeline, query = {}) {
  const match = mapQuery(query)
  const pipe = [{ $match: match }, ...pipeline]
  return [await ActivityLog.aggregate(pipe).allowDiskUse(true)]
}

export async function aggregateMerged(pipeline) {
  return ActivityLog.aggregate(pipeline).allowDiskUse(true)
}

export async function findByCategory(_category, query = {}, options = {}) {
  return findEvents(query, options)
}

export async function findEventById(id) {
  const doc =
    (await ActivityLog.findById(id).lean()) ||
    (await ActivityLog.findOne({ legacy_event_id: id }).lean())
  return doc ? logDocToLegacyEvent(doc) : null
}

export async function findEventByIdAndUpdate(id, update, options = {}) {
  const res = await ActivityLog.findByIdAndUpdate(id, update, options)
  return res
}

export async function findOneEvent(query = {}, options = {}) {
  const { select, sort, lean = true } = options
  let q = ActivityLog.findOne(mapQuery(query))
  if (select) q = q.select(mapSelect(select))
  if (sort) q = q.sort(sort)
  if (lean) q = q.lean()
  const doc = await q
  return doc ? logDocToLegacyEvent(doc) : null
}

export function getModelForType() {
  return ActivityLog
}

export function getCategoryForTypeWrapped(type) {
  return getCategoryForType(type)
}

export function getAllModels() {
  return [ActivityLog]
}

export const CATEGORY_MODELS = {
  screenshot: ActivityLog,
  interaction: ActivityLog,
  navigation: ActivityLog,
  tab: ActivityLog,
  activity: ActivityLog,
  system: ActivityLog
}

export { ActivityLog as ScreenshotEvent }
export { ActivityLog as InteractionEvent }
export { ActivityLog as NavigationEvent }
export { ActivityLog as TabEvent }
export { ActivityLog as ActivityEvent }
export { ActivityLog as SystemEvent }

function getTargetModels() {
  return [ActivityLog]
}
