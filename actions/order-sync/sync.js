/*
 * Export one order: skip if already exported, send, then record the outcome.
 * Used by the event handler (first attempt) and by the scheduled retry action.
 *
 * Two deliveries of the same order can race here (I/O Events redelivery while the first call is
 * still running, or a retry run overlapping a new event). Both may POST; the ERP's Idempotency-Key
 * turns the second into a 409, which sendOrder treats as success. State is the fast path, the ERP
 * is the guarantee.
 *
 * What State keeps: a retry entry holds the mapped ERP order (it has to be resent as is) for at
 * most 7 days. A dead-letter entry is kept for a year, so it drops the customer and the addresses:
 * the order number is enough for a human to look the rest up in Commerce.
 */
const { toErpOrder } = require('./mapper')
const { sendOrder } = require('./erp')

const MAX_RUNS = 6 // first delivery plus 5 scheduled retries

function withoutPersonalData ({ customer, billingAddress, shippingAddress, ...rest }) {
  return rest
}

async function exportOrder (order, { store, erp, logger, run = 1 }) {
  // A retry entry holds the already-mapped order; a fresh event holds the Commerce payload.
  const erpOrder = order.orderNumber ? order : toErpOrder(order)
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
    const meta = { runs: run, lastError: e.message, status: e.status || 0, at: new Date().toISOString() }
    if (e.detail) logger.debug(`order ${n}: ERP said ${e.detail}`)
    if (e.transient && run < MAX_RUNS) {
      await store.putRetry(n, { order: erpOrder, ...meta })
      logger.warn(`order ${n}: queued for retry ${run}/${MAX_RUNS - 1} (${e.message})`)
      return { orderNumber: n, outcome: 'queued' }
    }
    await store.clearRetry(n)
    await store.putDead(n, { order: withoutPersonalData(erpOrder), ...meta })
    logger.error(`order ${n}: failed for good after ${run} run(s) (${e.message})`)
    return { orderNumber: n, outcome: 'dead' }
  }
}

module.exports = { exportOrder, MAX_RUNS }
