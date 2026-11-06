/*
 * Ep 3: cron, config and custom tables, once your code leaves Magento.
 * Runs every 15 minutes (alarm trigger + rule in app.config.yaml), finds orders stuck in
 * pending_payment, and alerts once per order: State remembers what was alerted, and a
 * short-lived State key stops overlapping runs. With SAVE_REPORT=true it also keeps a CSV of
 * each run's newly alerted orders in Files (App Builder's blob storage), one file per day.
 */
const { Core } = require('@adobe/aio-sdk')
const stateLib = require('@adobe/aio-lib-state')
const filesLib = require('@adobe/aio-lib-files')

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

function toCsv (orders) {
  const cell = v => `"${String(v).replace(/"/g, '""')}"`
  const rows = orders.map(o => [o.increment_id, o.grand_total, o.created_at].map(cell).join(','))
  return ['increment_id,grand_total,created_at', ...rows].join('\n') + '\n'
}

async function saveReport (orders) {
  const files = await filesLib.init()
  const path = `reports/stuck-orders/${new Date().toISOString().slice(0, 10)}.csv`
  let previous = ''
  if ((await files.list(path)).length) {
    previous = (await files.read(path)).toString().split('\n').slice(1).join('\n')
  }
  const csv = toCsv(orders)
  await files.write(path, csv + previous)
  return path
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
      // The report is a record, not the alert: a Files failure is logged and never blocks or repeats the alert.
      if (fresh.length && String(params.SAVE_REPORT) === 'true') {
        try {
          logger.info(`report saved: ${await saveReport(fresh)}`)
        } catch (e) {
          logger.warn(`report not saved: ${e.message}`)
        }
      }
      logger.info(`stuck orders alerted: ${fresh.length}`)
      return { statusCode: 200, body: { alerted: fresh.length } }
    })
  } catch (e) {
    logger.error(e)
    return { statusCode: 500, body: { error: e.message } }
  }
}

module.exports = { main, findStuckOrders, newOnly, withLock, toCsv, saveReport }
