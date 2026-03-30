import mongoose from 'mongoose'

/** Screenshot metadata — `user_id` = extension tracker id. */
const screenshotRecordSchema = new mongoose.Schema(
  {
    screenshot_id: { type: String, required: true, unique: true },
    user_id: { type: String, required: true, index: true },
    ip: { type: String, default: '' },
    ts: { type: String, required: true, index: true },
    application: { type: String, default: '' },
    window_title: { type: String, default: '' },
    application_tab: { type: String, default: '' },
    operation: { type: String, default: '' },
    /** From extension batch extensionMeta (Chrome, Safari, Edge, …) */
    browser_name: { type: String, default: '' },
    client_os: { type: String, default: '' },
    screenshot_url: { type: String, default: '' },
    created_at: { type: String, required: true },
    legacy_event_id: { type: mongoose.Schema.Types.ObjectId, default: null }
  },
  { timestamps: false }
)

screenshotRecordSchema.index({ user_id: 1, ts: -1 })
screenshotRecordSchema.index({ ip: 1, ts: -1 })
screenshotRecordSchema.index({ application: 1, ts: -1 })
screenshotRecordSchema.index({ operation: 1, ts: -1 })

export default mongoose.model('ScreenshotRecord', screenshotRecordSchema, 'screenshots')
