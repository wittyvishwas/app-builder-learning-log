/*
 * Order sync to an ERP, invoked by Adobe I/O Events for the Commerce event
 * `observer.sales_order_place_after` (registered with this runtime action as the consumer).
 *
 * The Ep 1 version of this action (inputs check only) is at tag ep1-project-anatomy.
 * Return codes matter: a 2xx tells I/O Events the event is handled (exported, skipped or
 * queued for our own retry); a 5xx makes I/O Events redeliver it, which we only want when
 * we couldn't even record the failure.
 */
const { Core } = require('@adobe/aio-sdk')
const { errorResponse, checkMissingRequestInputs } = require('../utils')
const { exportOrder } = require('../order-sync/sync')
const store = require('../order-sync/store')

function orderFromEvent (params) {
  // I/O Events delivers the Commerce payload under data.value; accept a bare order for manual runs.
  return params.data?.value || params.value || (params.increment_id ? params : null)
}

async function main (params) {
  const logger = Core.Logger('export-order', { level: params.LOG_LEVEL || 'info' })
  const missing = checkMissingRequestInputs(params, ['ERP_API_URL', 'ERP_API_KEY'], [])
  if (missing) return errorResponse(400, missing, logger)

  const order = orderFromEvent(params)
  if (!order || !order.increment_id) {
    // Nothing to retry: redelivering a malformed event won't fix it.
    logger.error(`event ${params.event_id || params.id || '?'} has no order`)
    return { statusCode: 200, body: { outcome: 'ignored', reason: 'no order in event' } }
  }

  try {
    const result = await exportOrder(order, {
      store: await store.open(),
      erp: { url: params.ERP_API_URL, apiKey: params.ERP_API_KEY },
      logger
    })
    return { statusCode: 200, body: result }
  } catch (e) {
    logger.error(e)
    return errorResponse(500, `order ${order.increment_id}: ${e.message}`, logger)
  }
}

exports.main = main
