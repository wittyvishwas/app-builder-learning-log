/*
 * Ep 1: the anatomy of a project. The smallest useful action: check inputs, log, answer.
 * It doesn't call an ERP yet; the developer log fills that in.
 */
const { Core } = require('@adobe/aio-sdk')
const { errorResponse, checkMissingRequestInputs } = require('../utils')

async function main (params) {
  const logger = Core.Logger('export-order', { level: params.LOG_LEVEL || 'info' })
  const missing = checkMissingRequestInputs(params, ['ERP_API_URL'], [])
  if (missing) return errorResponse(400, missing, logger)

  logger.info('export-order called')
  return { statusCode: 200, body: { ok: true } }
}
exports.main = main
