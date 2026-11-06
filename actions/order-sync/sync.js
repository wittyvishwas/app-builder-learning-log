/*
 * Export one order: skip if already exported, send, then record the outcome.
 * Used by the event handler (first attempt) and by the scheduled retry action.
 */
const { toErpOrder } = require('./mapper')
const { sendOrder } = require('./erp')

const MAX_RUNS = 6 // first delivery plus 5 scheduled retries

async function exportOrder (order, { store, erp, logger, run = 1 }) {
  const erpOrder = toErpOrder(order)
  const n = erpOrder.orderNumber
  if (await store.isDone(n)) {
    logger.info(`order ${n}: already exported, skipped`)
    return { orderNumber: n, outcome: 'skipped' }
  }
  try {
    const res = await sendOrder(erpOrder, erp)
    await store.markDone(n)
    await store.clearRetry(n)
    logger.info(`order ${n}: exported${res.duplicate ? ' (ERP already had it)' : ''}`)
    return { orderNumber: n, outcome: 'exported' }
  } catch (e) {
    const entry = { order, runs: run, lastError: e.message, at: new Date().toISOString() }
    if (e.transient && run < MAX_RUNS) {
      await store.putRetry(n, entry)
      logger.warn(`order ${n}: queued for retry (${e.message})`)
      return { orderNumber: n, outcome: 'queued' }
    }
    await store.clearRetry(n)
    await store.putDead(n, entry)
    logger.error(`order ${n}: failed for good (${e.message})`)
    return { orderNumber: n, outcome: 'dead' }
  }
}

module.exports = { exportOrder, MAX_RUNS }
