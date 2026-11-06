/*
 * Order-sync bookkeeping in App Builder State (key-value, with a time to live).
 *   order-sync.done.<n>   exported, so a redelivered event is skipped     (30 days)
 *   order-sync.retry.<n>  transient failure, retried by the scheduled action (7 days)
 *   order-sync.dead.<n>   permanent failure or retries exhausted, for a human (365 days)
 *   order-sync.lock.<name> held while a scheduled run is in progress        (seconds)
 * Values are JSON. Keys allow letters, digits, - _ and . only, so order numbers are sanitised.
 *
 * What is stored: the retry and dead entries keep the mapped ERP order, not the raw event, and
 * without the customer block. The order number is enough to look the rest up in Commerce.
 */
const stateLib = require('@adobe/aio-lib-state')

const DAY = 24 * 3600
// 365 days is the State maximum (aio-lib-state MAX_TTL); a larger value is rejected with ERROR_BAD_REQUEST.
const TTL = { done: 30 * DAY, retry: 7 * DAY, dead: 365 * DAY }
const PREFIX = 'order-sync'

const safe = n => String(n).replace(/[^a-zA-Z0-9-_.]/g, '_')
const key = (kind, orderNumber) => `${PREFIX}.${kind}.${safe(orderNumber)}`

async function open () {
  const state = await stateLib.init()
  const get = async (k) => {
    const r = await state.get(k)
    return r && r.value !== undefined ? JSON.parse(r.value) : null
  }
  const put = (k, v, ttl) => state.put(k, JSON.stringify(v), { ttl })
  return {
    isDone: async n => Boolean(await state.get(key('done', n))),
    markDone: n => put(key('done', n), { at: new Date().toISOString() }, TTL.done),
    getRetry: n => get(key('retry', n)),
    putRetry: (n, entry) => put(key('retry', n), entry, TTL.retry),
    clearRetry: n => state.delete(key('retry', n)),
    putDead: (n, entry) => put(key('dead', n), entry, TTL.dead),
    getByKey: get,

    // list() is a cursor scan (every call scans 1000 keys): a key written during the scan may or
    // may not show up, and a key can be returned more than once. Take the snapshot first, de-duplicated,
    // and only then start writing, so one run never retries the same order twice.
    async retryKeys () {
      const keys = new Set()
      for await (const page of state.list({ match: `${PREFIX}.retry.*` })) {
        for (const k of page.keys) keys.add(k)
      }
      return [...keys]
    },

    // Atomic: put with ifNotExists resolves to null when the key already exists (aio-lib-state >= 5.4).
    async acquireLock (name, seconds) {
      const got = await state.put(key('lock', name), String(Date.now()), { ttl: seconds, ifNotExists: true })
      return got !== null
    },
    releaseLock: name => state.delete(key('lock', name))
  }
}

module.exports = { open }
