/*
 * Ep 11: read events from an Adobe I/O Events journaling endpoint and, only when asked, post ONE chosen event to a
 * local handler (the order-placed action under `aio app dev`).
 *
 *   node dev/run-ep11/journal-pull.js --order <increment_id> [--post <localHandlerUrl>]
 *
 * Without --post it is a dry run: it lists the events of that order and posts nothing. Events of other orders are
 * counted, never printed. With --post it posts the body of the first matching event and prints `event <id> -> <status>`.
 * The URL must point at this machine (localhost, 127.0.0.1, [::1], host.docker.internal): this is a local test tool.
 *
 * .env: JOURNAL_URL (the journaling endpoint of the registration), IMS_OAUTH_S2S_CLIENT_ID / _CLIENT_SECRET / _ORG_ID /
 * _SCOPES (the OAuth server-to-server credential the workspace already uses; the client id is also the x-api-key).
 * JOURNAL_API_KEY overrides the x-api-key when it is not the client id. The token and the key are never printed.
 *
 * Request shape (Adobe docs: https://developer.adobe.com/events/docs/guides/api/journaling-api, intro at
 * https://developer.adobe.com/events/docs/guides/journaling-intro): GET the journaling URL with headers
 * `Authorization: Bearer <OAuth S2S token>`, `x-api-key`, `x-ims-org-id`. 200 answers
 * { events: [{ position, event: { '@id', ..., data } }], _page: { last, count } } and a `Link: <...?since=<last>>; rel="next"`
 * header; 204 means no newer events (its `next` link points at the same position). The docs say to follow the link
 * instead of building the URL. This script reads what is there and stops at the first 204; it does not wait or poll.
 * The I/O Management API must be added to the workspace, or the journal answers 403.
 *
 * The pure parts are exported and unit-tested (test/journal-pull.test.js); the CLI wrapper at the bottom is thin.
 */
const { loadEnv, need } = require('../run-ep8/env')

const MAX_PAGES = 50
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'])

class UsageError extends Error {}

const USAGE = 'usage: node dev/run-ep11/journal-pull.js --order <increment_id> [--post <localHandlerUrl>]'

// Pure. Returns { order, post }. Throws UsageError (exit code 2) for anything else.
function parseArgs (argv) {
  const out = { order: undefined, post: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--order' || a === '--post') {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value\n${USAGE}`)
      out[a.slice(2)] = v
    } else {
      throw new UsageError(`unknown argument ${a}\n${USAGE}`)
    }
  }
  if (!out.order) throw new UsageError(`--order is required\n${USAGE}`)
  if (out.post !== undefined) {
    let u
    try { u = new URL(out.post) } catch { throw new UsageError(`--post is not a URL\n${USAGE}`) }
    if (!/^https?:$/.test(u.protocol) || !LOCAL_HOSTS.has(u.hostname)) {
      throw new UsageError(`--post must be an http(s) URL on this machine (${[...LOCAL_HOSTS].join(', ')})`)
    }
  }
  return out
}

// The id of a journal entry: the event's own @id, else the journal position.
const eventId = entry => entry?.event?.['@id'] ?? entry?.event?.id ?? entry?.position

// The order number of an event: data.value.order.increment_id (Ep 6/10 field names).
const orderOf = entry => entry?.event?.data?.value?.order?.increment_id

const matchesOrder = (entry, order) => orderOf(entry) === order

// Pure. The first GET of the journal: the URL as configured, no parameters (the oldest events first).
function buildRequest (env, token) {
  const apiKey = env.JOURNAL_API_KEY || env.IMS_OAUTH_S2S_CLIENT_ID
  return {
    url: env.JOURNAL_URL,
    options: {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'x-api-key': apiKey, 'x-ims-org-id': env.IMS_OAUTH_S2S_ORG_ID }
    }
  }
}

// Pure. The rel="next" URL of a Link header (absolute, resolved against the journal URL), or undefined.
function nextLink (linkHeader, baseUrl) {
  if (!linkHeader) return undefined
  for (const part of String(linkHeader).split(/,(?=\s*<)/)) {
    const m = /<([^>]*)>(.*)/.exec(part.trim())
    if (m && /rel\s*=\s*"?next"?/i.test(m[2])) return new URL(m[1], baseUrl).toString()
  }
  return undefined
}

const header = (res, name) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : undefined)

// Reads every page that is there: follows `next` while a page has events, stops at 204 or an empty page.
// Throws with the status only (never the response body, headers or token).
async function pullEvents (fetchImpl, request) {
  const entries = []
  let url = request.url
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const res = await fetchImpl(url, request.options)
    if (res.status === 204) break
    if (res.status !== 200) throw new Error(`journal answered ${res.status}`)
    const body = await res.json()
    const events = Array.isArray(body?.events) ? body.events : []
    if (!events.length) break
    entries.push(...events)
    url = nextLink(header(res, 'link'), request.url)
  }
  return entries
}

// POST the event body (the `event` object, what a Runtime action gets as params) to the handler.
async function postEvent (fetchImpl, url, entry) {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry.event) })
  return res.status
}

// The whole run with everything injected: returns the exit code. getToken(env) -> string.
async function run ({ argv, env, fetchImpl, getToken, log = console.log, err = console.error }) {
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    err(e.message)
    return 2
  }
  try {
    need(env, ['JOURNAL_URL', 'IMS_OAUTH_S2S_ORG_ID'])
    if (!env.JOURNAL_API_KEY) need(env, ['IMS_OAUTH_S2S_CLIENT_ID'])
    const entries = await pullEvents(fetchImpl, buildRequest(env, await getToken(env)))
    const matching = entries.filter(e => matchesOrder(e, args.order))
    const others = entries.length - matching.length

    if (!args.post) {
      for (const e of matching) log(`event ${eventId(e)} order ${args.order} (dry run)`)
    } else if (matching.length) {
      log(`event ${eventId(matching[0])} -> ${await postEvent(fetchImpl, args.post, matching[0])}`)
      if (matching.length > 1) log(`${matching.length - 1} more event(s) of this order not posted`)
    }
    log(`${entries.length} event(s) read, ${matching.length} for order ${args.order}, ${others} for other orders (not listed)`)
    return 0
  } catch (e) {
    err(`journal-pull failed: ${e.message}`)
    return 1
  }
}

// Same OAuth server-to-server call as scripts/post-deploy-db-setup.js.
async function getToken (env) {
  const { Core } = require('@adobe/aio-sdk')
  const { parseScopes } = require('../../scripts/post-deploy-db-setup')
  need(env, ['IMS_OAUTH_S2S_CLIENT_ID', 'IMS_OAUTH_S2S_CLIENT_SECRET', 'IMS_OAUTH_S2S_ORG_ID', 'IMS_OAUTH_S2S_SCOPES'])
  const token = await Core.AuthClient.generateAccessToken({
    clientId: env.IMS_OAUTH_S2S_CLIENT_ID,
    clientSecret: env.IMS_OAUTH_S2S_CLIENT_SECRET,
    orgId: env.IMS_OAUTH_S2S_ORG_ID,
    scopes: parseScopes(env.IMS_OAUTH_S2S_SCOPES)
  })
  return token.access_token
}

module.exports = { parseArgs, matchesOrder, orderOf, eventId, buildRequest, nextLink, pullEvents, postEvent, run, UsageError }

if (require.main === module) {
  let env
  // Check the arguments before touching .env, so a usage error needs no credentials.
  try { parseArgs(process.argv.slice(2)) } catch (e) { console.error(e.message); process.exit(e instanceof UsageError ? 2 : 1) }
  try { env = loadEnv() } catch (e) { console.error(`journal-pull failed: cannot read .env (${e.code || e.message})`); process.exit(1) }
  run({ argv: process.argv.slice(2), env, fetchImpl: fetch, getToken }).then(code => process.exit(code))
}
