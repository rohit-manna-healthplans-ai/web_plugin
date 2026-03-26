/**
 * Event type taxonomy only — all events persist in `logs` (ActivityLog).
 * Legacy per-type Mongo collections are not used.
 */
export {
  EVENT_CATEGORIES,
  CATEGORY_LABEL,
  getCategoryForType
} from '../../constants/eventCategories.js'
