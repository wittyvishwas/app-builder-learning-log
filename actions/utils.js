/*
 * Small helpers, in the spirit of the utils.js that `aio app init` generates (Ep 1).
 */

function errorResponse (statusCode, message, logger) {
  if (logger && typeof logger.info === 'function') {
    logger.info(`${statusCode}: ${message}`)
  }
  return { error: { statusCode, body: { error: message } } }
}

function checkMissingRequestInputs (params, requiredParams = [], requiredHeaders = []) {
  const missingParams = requiredParams.filter(p => params[p] === undefined || params[p] === '')
  const headers = params.__ow_headers || {}
  const missingHeaders = requiredHeaders.filter(h => !headers[h.toLowerCase()])
  const missing = [...missingHeaders.map(h => `header '${h}'`), ...missingParams.map(p => `parameter '${p}'`)]
  return missing.length ? `missing ${missing.join(', ')}` : null
}

module.exports = { errorResponse, checkMissingRequestInputs }
