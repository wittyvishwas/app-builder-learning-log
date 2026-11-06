/*
 * Scheduled retry for order sync: every 10 minutes (trigger + rule in app.config.yaml),
 * re-send orders that failed with a transient error. After the last run an order moves to
 * the dead-letter list (order-sync.dead.*) for a human.
 */
const { Core } = require('@adobe/aio-sdk')
const { errorResponse, checkMissingRequestInputs } = require('../utils')
const { exportOrder } = require('../order-sync/sync')
const store = require('../order-sync/store')

async function main (params) {
  const logger = Core.Logger('export-order-retry', { level: params.LOG_LEVEL || 'info' })
  const missing = checkMissingRequestInputs(params, ['ERP_API_URL', 'ERP_API_KEY'], [])
  if (missing) return errorResponse(400, missing, logger)

  const s = await store.open()
  const erp = { url: params.ERP_API_URL, apiKey: params.ERP_API_KEY }
  const counts = { exported: 0, skipped: 0, queued: 0, dead: 0 }
  const limit = Number(params.MAX_PER_RUN || 50)
  let seen = 0
  try {
    for await (const k of s.retryKeys()) {
      if (seen++ >= limit) break
      const entry = await s.getByKey(k)
      if (!entry) continue
      const r = await exportOrder(entry.order, { store: s, erp, logger, run: entry.runs + 1 })
      counts[r.outcome]++
    }
  } catch (e) {
    logger.error(e)
    return errorResponse(500, e.message, logger)
  }
  logger.info(`retry run: ${JSON.stringify(counts)}`)
  return { statusCode: 200, body: counts }
}

exports.main = main
