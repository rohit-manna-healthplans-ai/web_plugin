import mongoose from 'mongoose'

const eventSchema = new mongoose.Schema(
  {
    ts: { type: Number, index: true },
    sessionId: { type: String, index: true },
    pageId: { type: String },
    userId: { type: String, index: true },
    projectId: { type: String, index: true },
    type: { type: String, index: true },
    data: { type: mongoose.Schema.Types.Mixed },
    ip: { type: String, index: true },
    extensionUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExtensionUser', index: true }
  },
  { timestamps: true }
)

eventSchema.index({ userId: 1, projectId: 1, ts: -1 })
eventSchema.index({ userId: 1, sessionId: 1, ts: -1 })
eventSchema.index({ userId: 1, type: 1, ts: -1 })
eventSchema.index({ userId: 1, projectId: 1, type: 1 })

export default mongoose.model('Event', eventSchema)
