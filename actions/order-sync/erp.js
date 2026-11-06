/*
 * Deliver one order to the ERP. Every request carries an Idempotency-Key (the order number),
 * so a retry can never create a second order. Transient failures (network, 429, 5xx) are
 * retried with backoff inside the call; anything else is permanent.
 */

class ErpError extends Error {
  constructor (message, { status = 0, transient = false } = {}) {
    super(message)
    this.status = status
    this.transient = transient
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function sendOnce (erpOrder, { url, apiKey, timeoutMs }) {
  let res
  try {
    res = await fetch(`${url.replace(/\/$/, '')}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Idempotency-Key': erpOrder.orderNumber
      },
      body: JSON.stringify(erpOrder),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (e) {
    throw new ErpError(`ERP unreachable: ${e.message}`, { transient: true })
  }
  if (res.ok) return { status: res.status, duplicate: false }
  // The ERP already has this order (an earlier attempt got through): that's success.
  if (res.status === 409) return { status: 409, duplicate: true }
  const transient = res.status === 429 || res.status >= 500
  // The body often echoes the request (email, address), so it stays out of the message that is
  // logged and stored; callers may log it at debug level.
  let detail = ''
  try { detail = (await res.text()).slice(0, 300) } catch (e) {}
  const err = new ErpError(`ERP returned ${res.status}`, { status: res.status, transient })
  err.detail = detail
  throw err
}

async function sendOrder (erpOrder, { url, apiKey, attempts = 3, baseDelayMs = 500, timeoutMs = 10000 } = {}) {
  let last
  for (let i = 1; i <= attempts; i++) {
    try {
      return await sendOnce(erpOrder, { url, apiKey, timeoutMs })
    } catch (e) {
      last = e
      if (!e.transient || i === attempts) break
      await sleep(baseDelayMs * 2 ** (i - 1))
    }
  }
  throw last
}

module.exports = { sendOrder, ErpError }
