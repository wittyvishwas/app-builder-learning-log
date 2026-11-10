/*
 * Test helper, not part of the order-sync design: a fake ERP as a public web action, so a real workspace run has
 * something to send orders to. POST /orders stores an order in State (201, or 409 for one it already has);
 * GET /orders?order=<n> reads it back. Point ERP_API_URL at this action's web URL (README, "Test helper: fake ERP").
 *
 * The URL is public, so every request needs `Authorization: Bearer <FAKE_ERP_API_KEY>`. An unset, empty or short
 * (< 16 characters) key refuses everything. Keys are compared as SHA-256 digests with crypto.timingSafeEqual.
 * Our own logs carry only the order number and an error code or name. The stored value never holds the key, LOG_LEVEL
 * or __ow_* fields. aio-lib-state logs its own error details when a put fails, and those can include the stored
 * payload: received orders may hold customer data, so use this in test workspaces only. A request whose stored
 * value would be over 64 KB gets 413. A State failure gives 503, so erp.js treats it as transient and retries
 * (a rejected main would reach the caller as 204 or 400 instead).
 *
 * Not letting a caller pass FAKE_ERP_API_KEY (or LOG_LEVEL) in the body relies on `final: true` in app.config.yaml:
 * Runtime refuses to override the inputs of a final action. Keep that annotation.
 */
const crypto = require('crypto')
const stateLib = require('@adobe/aio-lib-state')
const { Core } = require('@adobe/aio-sdk')

const MIN_KEY_LENGTH = 16
const TTL_SECONDS = 604800 // 7 days
const MAX_STORED_BYTES = 64 * 1024
// Our own limit, inside what State allows for a key (^[a-zA-Z0-9-_.]{1,1024}$) once the prefix is added.
const ORDER_NUMBER = /^[A-Za-z0-9_.-]{1,64}$/

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body
})

const digest = s => crypto.createHash('sha256').update(String(s)).digest()

function authorized (params) {
  const key = params.FAKE_ERP_API_KEY
  if (typeof key !== 'string' || key.length < MIN_KEY_LENGTH) return false
  const header = (params.__ow_headers || {}).authorization
  if (typeof header !== 'string') return false
  const m = /^Bearer (.+)$/.exec(header)
  if (!m) return false
  return crypto.timingSafeEqual(digest(m[1]), digest(key))
}

const validOrder = n => typeof n === 'string' && ORDER_NUMBER.test(n)

async function main (params) {
  const logger = Core.Logger('fake-erp', { level: params.LOG_LEVEL || 'info' })
  if (!authorized(params)) return reply(401, { error: 'unauthorized' })

  const method = String(params.__ow_method || '').toLowerCase()
  const path = String(params.__ow_path || '').replace(/\/$/, '')
  if (path !== '/orders' || (method !== 'post' && method !== 'get')) return reply(404, { error: 'not found' })

  const n = method === 'get' ? params.order : params.orderNumber
  if (!validOrder(n)) return reply(400, { error: method === 'get' ? 'invalid or missing order' : 'invalid or missing orderNumber' })
  const key = `fake-erp.${n}`

  let stored
  if (method === 'post') {
    const order = {}
    for (const [k, v] of Object.entries(params)) {
      if (k.startsWith('__ow_') || k === 'FAKE_ERP_API_KEY' || k === 'LOG_LEVEL') continue
      order[k] = v
    }
    stored = JSON.stringify({ ...order, receivedAt: new Date().toISOString() })
    if (Buffer.byteLength(stored) > MAX_STORED_BYTES) return reply(413, { error: 'order too large' })
  }

  // Any State failure answers 503 with a fixed body: the message could echo the stored payload.
  try {
    const state = await stateLib.init()
    if (method === 'get') {
      const found = await state.get(key)
      if (!found) return reply(404, { error: 'not found' })
      return reply(200, JSON.parse(found.value))
    }
    const put = await state.put(key, stored, { ttl: TTL_SECONDS, ifNotExists: true })
    logger.info(`order ${n} ${put === null ? 'duplicate' : 'stored'}`)
    if (put === null) return reply(409, { duplicate: n })
    return reply(201, { stored: n })
  } catch (e) {
    logger.error(`order ${n}: storage failed (${e.code || e.name})`)
    return reply(503, { error: 'storage unavailable' })
  }
}

module.exports = { main }
