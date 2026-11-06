/*
 * Ep 3: cron, config and custom tables, once your code leaves Magento.
 * Runs every 15 minutes (alarm trigger + rule in app.config.yaml), finds orders stuck in
 * pending_payment, and alerts once per order: State remembers what was alerted, and a
 * short-lived State key stops overlapping runs.
 */
const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')

async function findStuckOrders (params) {
  const cutoff = new Date(Date.now() - Number(params.STUCK_AFTER_MINUTES) * 60000)
    .toISOString().slice(0, 19).replace('T', ' ')
  const q = new URLSearchParams({
    'searchCriteria[filter_groups][0][filters][0][field]': 'status',
    'searchCriteria[filter_groups][0][filters][0][value]': 'pending_payment',
    'searchCriteria[filter_groups][1][filters][0][field]': 'created_at',
    'searchCriteria[filter_groups][1][filters][0][value]': cutoff,
    'searchCriteria[filter_groups][1][filters][0][condition_type]': 'lt',
    'searchCriteria[pageSize]': '50',
    fields: 'items[increment_id,grand_total,created_at]'
  })
  const res = await fetch(`${params.COMMERCE_BASE_URL}rest/V1/orders?${q}`, {
    headers: { Authorization: `Bearer ${params.COMMERCE_TOKEN}` }
  })
  if (!res.ok) throw new Error(`Commerce returned ${res.status}`)
  return (await res.json()).items || []
}

async function newOnly (orders) {
  const state = await stateLib.init()
  const fresh = []
  for (const o of orders) {
    const key = `stuck-${o.increment_id}`
    if (await state.get(key)) continue
    await state.put(key, '1', { ttl: 7 * 24 * 3600 })
    fresh.push(o)
  }
  return fresh
}

async function withLock (name, seconds, fn) {
  const state = await stateLib.init()
  if (await state.get(`lock-${name}`)) return { skipped: true }
  await state.put(`lock-${name}`, String(Date.now()), { ttl: seconds })
  try { return await fn() } finally { await state.delete(`lock-${name}`) }
}

async function main (params) {
  const logger = Core.Logger('stuck-orders', { level: params.LOG_LEVEL || 'info' })
  try {
    return await withLock('stuck-orders', 600, async () => {
      const fresh = await newOnly(await findStuckOrders(params))
      if (fresh.length) {
        const lines = fresh.map(o => `#${o.increment_id} (${o.grand_total}) since ${o.created_at}`)
        await fetch(params.ALERT_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `Orders stuck in pending_payment:\n${lines.join('\n')}` })
        })
      }
      logger.info(`stuck orders alerted: ${fresh.length}`)
      return { statusCode: 200, body: { alerted: fresh.length } }
    })
  } catch (e) {
    logger.error(e)
    return { statusCode: 500, body: { error: e.message } }
  }
}

module.exports = { main, findStuckOrders, newOnly, withLock }
