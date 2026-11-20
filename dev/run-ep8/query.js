/*
 * Sends a named query from queries.json to the mesh and prints what the cache and batching checks need.
 *   node dev/run-ep8/query.js <queryName> [--get] [--repeat n] [--origin <url>] [--wait s]
 * POST by default; --get sends GET with ?query=. MESH_URL (the mesh endpoint, added to .env after `mesh.sh describe`),
 * FAKE_REVIEWS_URL and FAKE_REVIEWS_API_KEY come from .env. Each result is also one JSON line in out/results.jsonl.
 */
const fs = require('fs')
const path = require('path')
const { loadEnv, need } = require('./env')

const OUT = path.join(__dirname, 'out')
const SHOW = ['Cache-Control', 'Cache-Status', 'Age', 'Etag', 'Expires', 'Access-Control-Allow-Origin']

function flags (args) {
  const out = { _: [] }
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) { out._.push(args[i]); continue }
    const name = args[i].slice(2)
    out[name] = name === 'get' ? true : args[++i]
  }
  return out
}

// A query entry is a string, or { base, getUrlLength }: the base query plus a GraphQL comment, so that the full GET
// URL (endpoint + ?query= + the encoded query) is exactly getUrlLength characters.
function resolveQuery (queries, name, meshUrl) {
  const q = queries[name]
  if (q === undefined) throw new Error(`unknown query ${name} (one of ${Object.keys(queries).join(', ')})`)
  if (typeof q === 'string') return q
  const base = queries[q.base]
  const urlFor = text => `${meshUrl}?query=${encodeURIComponent(text)}`
  const start = base + '\n#'
  const pad = q.getUrlLength - urlFor(start).length
  if (pad < 0) throw new Error(`${name}: the base query already makes the URL longer than ${q.getUrlLength}`)
  return start + 'x'.repeat(pad)
}

async function fakeCalls (env, since) {
  const res = await fetch(env.FAKE_REVIEWS_URL.replace(/\/$/, '') + `/calls?since=${since}`, { headers: { 'x-mm-key': env.FAKE_REVIEWS_API_KEY } })
  if (!res.ok) throw new Error(`fake /calls answered ${res.status}`)
  return (await res.json()).calls
}

async function main (argv) {
  const f = flags(argv)
  const name = f._[0]
  if (!name) throw new Error('usage: query.js <queryName> [--get] [--repeat n] [--origin <url>] [--wait s]')
  const env = loadEnv()
  need(env, ['MESH_URL', 'FAKE_REVIEWS_URL', 'FAKE_REVIEWS_API_KEY'])
  const queries = JSON.parse(fs.readFileSync(path.join(__dirname, 'queries.json'), 'utf8'))
  const query = resolveQuery(queries, name, env.MESH_URL)
  fs.mkdirSync(OUT, { recursive: true })

  const runStart = Date.now() // only calls made during this run are listed (the action filters on the call time in its key)
  let seen = new Set((await fakeCalls(env, runStart)).map(c => c.callId))
  for (let i = 0; i < Number(f.repeat || 1); i++) {
    if (i > 0 && f.wait) await new Promise(resolve => setTimeout(resolve, Number(f.wait) * 1000))
    const headers = { 'Content-Type': 'application/json', ...(f.origin ? { Origin: f.origin } : {}) }
    const url = f.get ? `${env.MESH_URL}?query=${encodeURIComponent(query)}` : env.MESH_URL
    const started = Date.now()
    const res = await fetch(url, f.get ? { headers } : { method: 'POST', headers, body: JSON.stringify({ query }) })
    const text = await res.text()
    const ms = Date.now() - started

    let errors = []
    try { errors = (JSON.parse(text).errors || []).map(e => e.message) } catch (e) { errors = ['(body is not JSON)'] }
    const callIds = [...new Set(text.match(/\d{13}-[0-9a-f]{6}/g) || [])]
    const calls = await fakeCalls(env, runStart)
    const fresh = calls.filter(c => !seen.has(c.callId))
    seen = new Set(calls.map(c => c.callId))
    const newCalls = {}
    for (const c of fresh) newCalls[c.route] = (newCalls[c.route] || 0) + 1

    const result = {
      at: new Date().toISOString(),
      query: name,
      method: f.get ? 'GET' : 'POST',
      urlLength: f.get ? url.length : undefined,
      status: res.status,
      ms,
      headers: Object.fromEntries(SHOW.map(h => [h, res.headers.get(h)])),
      callIds,
      errors,
      newCalls
    }
    fs.appendFileSync(path.join(OUT, 'results.jsonl'), JSON.stringify(result) + '\n')
    console.log(`#${i + 1} ${result.method} ${name}${f.get ? ` (URL ${url.length} chars)` : ''}: HTTP ${res.status}, ${ms} ms`)
    for (const h of SHOW) console.log(`  ${h}: ${result.headers[h]}`)
    console.log(`  callIds in body: ${callIds.join(', ') || '-'}`)
    console.log(`  errors: ${errors.join(' | ') || '-'}`)
    console.log(`  new fake calls: ${JSON.stringify(newCalls)}`)
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exit(1) })
module.exports = { resolveQuery }
