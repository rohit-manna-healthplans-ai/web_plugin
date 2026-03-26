import mongoose from 'mongoose'

/**
 * Web dashboard accounts only — collection `dashboard_users`.
 */
const userSchema = new mongoose.Schema(
  {
    email: { type: String },
    passwordHash: { type: String },
    name: { type: String },
    isAdmin: { type: Boolean, default: false, index: true },
    role: {
      type: String,
      enum: ['admin', 'project_manager', 'client'],
      index: true
    },
    projectId: { type: String, index: true }
  },
  { timestamps: true }
)

userSchema.virtual('effectiveRole').get(function () {
  if (this.role) return this.role
  if (this.isAdmin) return 'admin'
  return 'client'
})

userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $exists: true, $type: 'string' } } }
)

export default mongoose.model('User', userSchema, 'dashboard_users')
