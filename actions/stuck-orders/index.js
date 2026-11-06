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

const PAGE_SIZE = 50
// State keys allow letters, digits, - _ and . only (aio-lib-state REGEX_PATTERN_STORE_KEY).
const safe = v => String(v).replace(/[^a-zA-Z0-9-_.]/g, '_')

// Oldest first, so the orders stuck longest are alerted first; with more than PAGE_SIZE stuck
// orders the rest follow on later runs because alerted ones are filtered out in newOnly().
function stuckOrdersQuery (params) {
  const cutoff = new Date(Date.now() - Number(params.STUCK_AFTER_MINUTES) * 60000)
    .toISOString().slice(0, 19).replace('T', ' ')
  return new URLSearchParams({
    'searchCriteria[filter_groups][0][filters][0][field]': 'status',
    'searchCriteria[filter_groups][0][filters][0][value]': 'pending_payment',
    'searchCriteria[filter_groups][1][filters][0][field]': 'created_at',
    'searchCriteria[filter_groups][1][filters][0][value]': cutoff,
    'searchCriteria[filter_groups][1][filters][0][condition_type]': 'lt',
    'searchCriteria[sortOrders][0][field]': 'created_at',
    'searchCriteria[sortOrders][0][direction]': 'ASC',
    'searchCriteria[pageSize]': String(PAGE_SIZE),
    fields: 'items[increment_id,grand_total,created_at]'
  })
}

async function findStuckOrders (params) {
  const base = String(params.COMMERCE_BASE_URL).replace(/\/+$/, '')
  const res = await fetch(`${base}/rest/V1/orders?${stuckOrdersQuery(params)}`, {
    headers: { Authorization: `Bearer ${params.COMMERCE_TOKEN}` }
  })
  if (!res.ok) throw new Error(`Commerce returned ${res.status}`)
  return (await res.json()).items || []
}

// Orders not alerted yet. Nothing is written here: an order is remembered only after the
// alert went out (see markAlerted), so a failing webhook doesn't silently swallow orders.
async function notAlertedYet (state, orders) {
  const fresh = []
  for (const o of orders) {
    if (!(await state.get(`stuck-${safe(o.increment_id)}`))) fresh.push(o)
  }
  return fresh
}

async function markAlerted (state, orders) {
  for (const o of orders) {
    await state.put(`stuck-${safe(o.increment_id)}`, '1', { ttl: 7 * 24 * 3600 })
  }
}

async function sendAlert (webhookUrl, orders) {
  const lines = orders.map(o => `#${o.increment_id} (${o.grand_total}) since ${o.created_at}`)
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `Orders stuck in pending_payment:\n${lines.join('\n')}` })
  })
  if (!res.ok) throw new Error(`alert webhook returned ${res.status}`)
}

// One atomic put: `ifNotExists` (aio-lib-state >= 5.4) resolves to null when the key is already
// there, so two runs can't both believe they got the lock. The TTL frees a lock left by a crash.
async function withLock (state, name, seconds, fn) {
  const key = `lock-${name}`
  const got = await state.put(key, String(Date.now()), { ttl: seconds, ifNotExists: true })
  if (got === null) return { skipped: true }
  try { return await fn() } finally { await state.delete(key) }
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
  await files.write(path, toCsv(orders) + previous)
  return path
}

async function main (params) {
  const logger = Core.Logger('stuck-orders', { level: params.LOG_LEVEL || 'info' })
  try {
    const state = await stateLib.init()
    return await withLock(state, 'stuck-orders', 600, async () => {
      const fresh = await notAlertedYet(state, await findStuckOrders(params))
      if (fresh.length) {
        await sendAlert(params.ALERT_WEBHOOK_URL, fresh)
        await markAlerted(state, fresh)
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

module.exports = { main, toCsv }
