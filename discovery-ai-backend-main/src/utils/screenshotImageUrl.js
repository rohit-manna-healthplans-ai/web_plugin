/**
 * Canonical screenshot image URL from event.data (Azure preferred; cloudinaryUrl for legacy docs).
 */
export function getScreenshotImageUrlFromData(data) {
  if (!data || typeof data !== 'object') return null
  if (typeof data.imageUrl === 'string' && data.imageUrl.trim()) return data.imageUrl.trim()
  if (typeof data.cloudinaryUrl === 'string' && data.cloudinaryUrl.trim()) return data.cloudinaryUrl.trim()
  return null
}
