/**
 * Event type → category (for logs.category + analytics). No Mongo event collections.
 */

export const EVENT_CATEGORIES = {
  /** Extension + desktop aligned (uppercase codes) */
  screenshot: ['screenshot'],
  interaction: [
    'CLICK',
    'PASTE',
    'TYPED_FLUSH',
    'KEY',
    'click',
    'button_click',
    'input',
    'change',
    'blur',
    'form_submit',
    'key_down',
    'key_up',
    'sentence_typed',
    'keyboard_shortcut',
    'keyboard_other',
    'media_play',
    'media_pause',
    'input_polled',
    'field_focus',
    'field_blur',
    'clipboard_paste',
    'clipboard_copy',
    'context_menu',
    'dblclick',
    'form_snapshot'
  ],
  navigation: [
    'page_view',
    'navigation',
    'performance_navigation',
    'page_load',
    'page_event',
    'route_change',
    'pageview',
    'spa_navigation'
  ],
  tab: [
    'SWITCH',
    'tab_created',
    'tab_updated',
    'tab_activated',
    'tab_deactivated',
    'tab_removed',
    'windows_blurred'
  ],
  activity: [
    'SCROLL',
    'heartbeat',
    'page_heartbeat',
    'window_blur',
    'window_focus',
    'inactive_start',
    'inactive_end',
    'visibility_change',
    'scroll'
  ],
  system: [
    'USER_LOGGED_IN',
    'USER_LOGGED_OUT',
    'session_start',
    'session_end',
    'session_pause',
    'session_resume',
    'event',
    'unknown'
  ]
}

const _typeToCategory = {}
for (const [category, types] of Object.entries(EVENT_CATEGORIES)) {
  for (const t of types) {
    _typeToCategory[t] = category
  }
}

export const CATEGORY_LABEL = {
  screenshot: 'Screenshot',
  interaction: 'Interaction',
  navigation: 'Navigation',
  tab: 'Tab',
  activity: 'Activity',
  system: 'System'
}

export function getCategoryForType(type) {
  return _typeToCategory[type] || 'system'
}
