/*
 * Order-sync bookkeeping in App Builder State (key-value, with a time to live).
 *   order-sync.done.<n>   exported, so a redelivered event is skipped     (30 days)
 *   order-sync.retry.<n>  transient failure, retried by the scheduled action (7 days)
 *   order-sync.dead.<n>   permanent failure or retries exhausted, for a human (365 days)
 * Values are JSON. Keys allow letters, digits, - _ and . only, so order numbers are sanitised.
 */
const stateLib = require('@adobe/aio-lib-state')

const DAY = 24 * 3600
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
    async * retryKeys () {
      for await (const { keys } of state.list({ match: `${PREFIX}.retry.*` })) {
        for (const k of keys) yield k
      }
    },
    getByKey: get
  }
}

module.exports = { open, key }
