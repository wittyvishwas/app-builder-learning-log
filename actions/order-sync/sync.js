/*
 * Export one order: skip if already exported, send, then record the outcome.
 * Used by the event handler (first attempt) and by the scheduled retry action.
 *
 * Two deliveries of the same order can race here (I/O Events redelivery while the first call is
 * still running, or a retry run overlapping a new event). Both may POST; the ERP's Idempotency-Key
 * turns the second into a 409, which sendOrder treats as success. The export_runs row is the fast
 * path, the ERP is the guarantee.
 *
 * What the store keeps: a retry row holds the mapped ERP order (it has to be resent as is) until the
 * order is sent or dead. A dead row keeps lines and totals only: the order number is enough for a human
 * to look the rest up in Commerce.
 *
 * Logging: messages only. The ERP's response body (erp.js keeps it in err.detail) is never logged, at any level,
 * because ERPs often echo the request (email, address) and logs are forwarded to a third party.
 */
const { toErpOrder } = require('./mapper')
const { sendOrder } = require('./erp')

const MAX_RUNS = 6 // first delivery plus 5 scheduled retries

function deadSummary ({ lines, currency, total, shippingAmount, taxAmount }) {
  return { lines, totals: { currency, total, shippingAmount, taxAmount } }
}

async function exportOrder (order, { store, erp, logger, run = 1 }) {
  // A retry row holds the already-mapped order; a fresh event holds the Commerce payload.
  const erpOrder = order.orderNumber ? order : toErpOrder(order)
  const n = erpOrder.orderNumber
  if (await store.isDone(n)) {
    logger.info(`order ${n}: already exported, skipped`)
    return { orderNumber: n, outcome: 'skipped' }
  }
  try {
    const res = await sendOrder(erpOrder, erp)
    await store.markDone(n)
    logger.info(`order ${n}: exported${res.duplicate ? ' (ERP already had it)' : ''}`)
    return { orderNumber: n, outcome: 'exported' }
  } catch (e) {
    const meta = { attempts: run, lastError: e.message, httpStatus: e.status || 0 }
    if (e.transient && run < MAX_RUNS) {
      await store.putRetry(n, { mapped: erpOrder, ...meta })
      logger.warn(`order ${n}: queued for retry ${run}/${MAX_RUNS - 1} (${e.message})`)
      return { orderNumber: n, outcome: 'queued' }
    }
    await store.putDead(n, { ...deadSummary(erpOrder), ...meta })
    logger.error(`order ${n}: failed for good after ${run} run(s) (${e.message})`)
    return { orderNumber: n, outcome: 'dead' }
  }
}

module.exports = { exportOrder, MAX_RUNS }
