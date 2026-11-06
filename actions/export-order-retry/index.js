/*
 * Scheduled retry for order sync: every 10 minutes (trigger + rule in app.config.yaml),
 * re-send orders that failed with a transient error. They wait in the export_runs collection
 * (status 'retry', Ep 4); after the last run an order becomes a 'dead' row for a human.
 *
 * One try per order per run: the 10-minute schedule is the backoff, so there is no inline retry
 * here. When the ERP is down each order can still cost up to its 10 s request timeout, so the
 * batch is cut by elapsed time as well as by count (MAX_PER_RUN). The action timeout is 300 s in
 * app.config.yaml; TIME_BUDGET_MS leaves room for the last order to finish. What's left waits for
 * the next run and is reported as `left`.
 * A State lock stops a manual `aio rt action invoke` from overlapping the scheduled run. Database
 * Storage needs include-ims-credentials: true on this action, also when the alarm trigger calls it.
 */
const { Core } = require('@adobe/aio-sdk')
const { errorResponse, checkMissingRequestInputs } = require('../utils')
const { exportOrder } = require('../order-sync/sync')
const store = require('../order-sync/store')

const LOCK_SECONDS = 600 // the alarm period; frees a lock left behind by a crashed run
const TIME_BUDGET_MS = 240000

async function main (params) {
  const logger = Core.Logger('export-order-retry', { level: params.LOG_LEVEL || 'info' })
  const missing = checkMissingRequestInputs(params, ['ERP_API_URL', 'ERP_API_KEY'], [])
  if (missing) return errorResponse(400, missing, logger)

  const lock = await store.openLock()
  if (!(await lock.acquire('retry', LOCK_SECONDS))) {
    logger.info('retry run: skipped, another run holds the lock')
    return { statusCode: 200, body: { skipped: true } }
  }

  const erp = { url: params.ERP_API_URL, apiKey: params.ERP_API_KEY, attempts: 1 }
  const counts = { exported: 0, skipped: 0, queued: 0, dead: 0, left: 0 }
  const limit = Number(params.MAX_PER_RUN || 50)
  const started = Date.now()
  let db
  try {
    db = await store.connect(params)
    // Snapshot first: rows written during this run (nextAt is later than `started`) wait for the next one.
    const { rows, total } = await db.store.dueRetries(limit, new Date(started).toISOString())
    counts.left = total - rows.length
    for (const [i, row] of rows.entries()) {
      if (Date.now() - started > TIME_BUDGET_MS) {
        counts.left += rows.length - i
        break
      }
      const r = await exportOrder(row.mapped, { store: db.store, erp, logger, run: row.attempts + 1 })
      counts[r.outcome]++
    }
  } catch (e) {
    // Message only: never the whole error or an ERP response body.
    logger.error(`retry run: ${e.message}`)
    return errorResponse(500, e.message, logger)
  } finally {
    if (db) await db.close().catch(() => {})
    await lock.release('retry')
  }
  logger.info(`retry run: ${JSON.stringify(counts)}`)
  return { statusCode: 200, body: counts }
}

exports.main = main
