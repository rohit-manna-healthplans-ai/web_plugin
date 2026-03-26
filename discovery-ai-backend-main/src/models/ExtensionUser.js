import mongoose from 'mongoose'

const remoteCommandSubSchema = new mongoose.Schema(
  {
    command: {
      type: String,
      required: true,
      enum: ['start_session', 'end_session', 'pause_session', 'resume_session']
    },
    sessionName: { type: String, default: '' },
    status: {
      type: String,
      default: 'pending',
      enum: ['pending', 'delivered', 'executed', 'expired', 'cancelled']
    },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    deliveredAt: { type: Date },
    executedAt: { type: Date },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 5 * 60 * 1000) }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

/**
 * Plugin / extension users — single collection `plugin_users`.
 * Registered: username + password. Anonymous device: only trackerUserId (+ last_seen).
 */
const extensionUserSchema = new mongoose.Schema(
  {
    trackerUserId: { type: String, required: true, index: true },
    username: { type: String, sparse: true, unique: true },
    passwordHash: { type: String },
    lastIp: { type: String },
    meta: { type: mongoose.Schema.Types.Mixed },
    projectId: { type: String, index: true },
    /** Normalized lowercase; unique when set (telemetry + dashboard identity). */
    email: { type: String, sparse: true, unique: true },
    name: { type: String },
    isActive: { type: Boolean, default: true, index: true },
    stealthTracking: { type: Boolean, default: false },
    stealthSessionName: { type: String, default: '' },
    stealthStartedAt: { type: Date },
    last_seen_at: { type: String },
    first_seen_ip: { type: String },
    /** Last seen client from extension telemetry (Chrome, Microsoft Edge, …). */
    extensionBrowserName: { type: String, default: '' },
    extensionOs: { type: String, default: '' },
    extensionUserAgent: { type: String, default: '' },
    extensionVersionLast: { type: String, default: '' },
    remoteCommands: [remoteCommandSubSchema]
  },
  { timestamps: true }
)

extensionUserSchema.index({ trackerUserId: 1 })

export default mongoose.model('ExtensionUser', extensionUserSchema, 'plugin_users')
