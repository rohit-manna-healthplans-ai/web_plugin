import mongoose from 'mongoose'
import { createEventSchema } from './baseSchema.js'

/**
 * Screenshot events — image URL in data / url (no server-side OCR).
 */
const screenshotSchema = createEventSchema({
  captureReason: { type: String, index: true },
  url: { type: String }
})

// Compound { userId, sessionId, ts } is already registered in createEventSchema → applyBaseIndexes

export default mongoose.model('ScreenshotEvent', screenshotSchema, 'screenshot_events')
