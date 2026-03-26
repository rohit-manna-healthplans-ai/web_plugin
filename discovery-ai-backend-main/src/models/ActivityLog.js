import mongoose from 'mongoose'

/** Flat activity log — `user_id` = extension tracker UUID. */
const activityLogSchema = new mongoose.Schema(
  {
    log_id: { type: String, required: true, unique: true },
    user_id: { type: String, required: true, index: true },
    ip: { type: String, default: '' },
    ts: { type: String, required: true, index: true },
    /** Human-readable bucket: Screenshot, Interaction, Tab, … */
    category: { type: String, index: true },
    /** machine key: screenshot | interaction | navigation | tab | activity | system */
    category_key: { type: String, index: true },
    /** Same as extension event type e.g. click, tab_activated, screenshot */
    event_type: { type: String, index: true },
    session_id: { type: String, index: true },
    page_id: { type: String, index: true },
    project_id: { type: String, index: true },
    details: { type: String, default: '' },
    application: { type: String, default: '' },
    window_title: { type: String, default: '' },
    application_tab: { type: String, default: '' },
    operation: { type: String, index: true },
    screenshot_id: { type: String, default: null },
    created_at: { type: String, required: true },
    legacy_event_id: { type: mongoose.Schema.Types.ObjectId, default: null }
  },
  { timestamps: false }
)

activityLogSchema.index({ user_id: 1, ts: -1 })
activityLogSchema.index({ user_id: 1, event_type: 1, ts: -1 })
activityLogSchema.index({ user_id: 1, category_key: 1, ts: -1 })
activityLogSchema.index({ ip: 1, ts: -1 })
activityLogSchema.index({ application: 1, ts: -1 })
activityLogSchema.index({ operation: 1, ts: -1 })
activityLogSchema.index({ screenshot_id: 1 }, { sparse: true })

export default mongoose.model('ActivityLog', activityLogSchema, 'logs')
