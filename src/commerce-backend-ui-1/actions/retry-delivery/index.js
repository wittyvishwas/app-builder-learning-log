/*
 * Ep 10: the "Retry" button on the Deliveries view. Needs `order`, the order number.
 *   - a 'retry' row: nextAt = now, so the next retry run resends the stored order;
 *   - a 'dead' row: it keeps no order (no personal data), so the order is fetched again from Commerce (REST, filtered
 *     by increment_id), mapped with the order-sync mapper, and the row goes back to 'retry' with attempts 0;
 *   - a 'sent' row: 409, nothing to retry; no row: 404; order not in Commerce: 404; Commerce failing: 502.
 * The row is never written with a filter that could match a 'sent' row. Same auth and error rules as list-alerts.
 */
const { Core } = require('@adobe/aio-sdk')
const libDb = require('@adobe/aio-lib-db')
const { toErpOrder } = require('../../../../actions/order-sync/mapper')

const reply = (statusCode, error) => ({ statusCode, body: { error } })

// Commerce's REST order, found by its increment_id; null when there is none.
async function fetchOrder (params, order) {
  const base = String(params.COMMERCE_BASE_URL).replace(/\/+$/, '')
  const query = new URLSearchParams({
    'searchCriteria[filter_groups][0][filters][0][field]': 'increment_id',
    'searchCriteria[filter_groups][0][filters][0][value]': order,
    'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq'
  })
  const res = await fetch(`${base}/rest/V1/orders?${query}`, {
    headers: { Authorization: `Bearer ${params.COMMERCE_TOKEN}` }
  })
  if (!res.ok) throw new Error(`Commerce returned ${res.status}`)
  const found = ((await res.json()).items || []).find(o => String(o.increment_id) === order)
  return found || null
}

async function main (params) {
  const logger = Core.Logger('retry-delivery', { level: params.LOG_LEVEL || 'info' })
  if (typeof params.order !== 'string' || !params.order.trim()) return reply(400, 'order is required')
  const order = params.order
  let client
  try {
    const token = await Core.AuthClient.generateAccessToken(params)
    const db = await libDb.init({ token: token.access_token, region: 'emea' })
    client = await db.connect()
    const runs = await client.collection('export_runs')
    const now = () => new Date().toISOString()

    if (await runs.findOne({ order, status: 'sent' })) return reply(409, 'already sent')
    const row = await runs.findOne({ order, status: { $in: ['retry', 'dead'] } })
    if (!row) return reply(404, 'no such delivery')

    if (row.status === 'retry') {
      const res = await runs.updateOne({ order, status: 'retry' }, { $set: { nextAt: now() } })
      if (!res.matchedCount) return reply(409, 'delivery changed, reload')
      return { statusCode: 200, body: { order, status: 'retry' } }
    }

    let mapped
    try {
      const found = await fetchOrder(params, order)
      if (!found) return reply(404, 'order not found in Commerce')
      mapped = toErpOrder(found)
    } catch (e) {
      logger.error(e.message)
      return reply(502, 'commerce error')
    }
    // status 'dead' in the filter: a row that became sent (or retry) meanwhile is not touched.
    const res = await runs.updateOne({ order, status: 'dead' }, {
      $set: { status: 'retry', attempts: 0, nextAt: now(), mapped, lastError: null, httpStatus: null, lines: null, totals: null, at: now() }
    })
    if (!res.matchedCount) return reply(409, 'delivery changed, reload')
    return { statusCode: 200, body: { order, status: 'retry' } }
  } catch (e) {
    logger.error(e.message)
    return reply(500, e.name === 'DbError' ? 'database error' : 'internal error')
  } finally {
    if (client) await client.close()
  }
}
exports.main = main
