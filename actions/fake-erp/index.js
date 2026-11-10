/*
 * Test helper, not part of the order-sync design: a fake ERP as a public web action, so a real workspace run has
 * something to send orders to. POST /orders stores an order in State (201, or 409 for one it already has);
 * GET /orders?order=<n> reads it back. Point ERP_API_URL at this action's web URL (README, "Test helper: fake ERP").
 *
 * The URL is public, so every request needs `Authorization: Bearer <FAKE_ERP_API_KEY>`. An unset, empty or short
 * (< 16 characters) key refuses everything. Keys are compared as SHA-256 digests with crypto.timingSafeEqual.
 * Only the order number is logged. The stored value never holds the key, LOG_LEVEL or __ow_* fields.
 */
const crypto = require('crypto')
const stateLib = require('@adobe/aio-lib-state')

const MIN_KEY_LENGTH = 16
const TTL_SECONDS = 604800 // 7 days
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
  if (!authorized(params)) return reply(401, { error: 'unauthorized' })

  const method = String(params.__ow_method || '').toLowerCase()
  const path = String(params.__ow_path || '').replace(/\/$/, '')
  if (path !== '/orders' || (method !== 'post' && method !== 'get')) return reply(404, { error: 'not found' })

  const state = await stateLib.init()

  if (method === 'get') {
    const n = params.order
    if (!validOrder(n)) return reply(400, { error: 'invalid or missing order' })
    const found = await state.get(`fake-erp.${n}`)
    if (!found) return reply(404, { error: 'not found' })
    return reply(200, JSON.parse(found.value))
  }

  const n = params.orderNumber
  if (!validOrder(n)) return reply(400, { error: 'invalid or missing orderNumber' })
  const order = {}
  for (const [k, v] of Object.entries(params)) {
    if (k.startsWith('__ow_') || k === 'FAKE_ERP_API_KEY' || k === 'LOG_LEVEL') continue
    order[k] = v
  }
  const put = await state.put(`fake-erp.${n}`, JSON.stringify({ ...order, receivedAt: new Date().toISOString() }), {
    ttl: TTL_SECONDS,
    ifNotExists: true
  })
  console.log(`fake-erp: order ${n} ${put === null ? 'duplicate' : 'stored'}`)
  if (put === null) return reply(409, { duplicate: n })
  return reply(201, { stored: n })
}

module.exports = { main }
