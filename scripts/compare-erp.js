#!/usr/bin/env node
/*
 * Ep 10 run: compare what the app (order-sync) and the old module (MageMinion_OrderExport) sent to the fake ERP.
 *
 *   node scripts/compare-erp.js --url <fake-erp base> --key <api key> <increment_id>...
 *
 * For each id it reads GET <url>/orders?order=<id> (the app's record) and ?order=module-<id> (the module's record),
 * turns both into { lines: [{sku, qty}], address } and prints one block per order. CommonJS, no dependencies, so
 * jest can load the normaliser (test/compare-erp.test.js).
 *
 * Retries and duplicates are not in this output. Read them from the fake-erp activation logs, the app's `export_runs`
 * rows and the module's retry table (mageminion_order_export_retry) with its log file.
 */

const text = v => (v === undefined || v === null ? '' : String(v).trim())

function street (s) {
  return (Array.isArray(s) ? s.join('\n') : text(s)).trim()
}

// App record: shippingAddress { name, street, city, postcode, region, country }.
// Module record: shipping_address { firstname, lastname, street[], city, postcode, region, country_id }.
function normaliseAddress (a) {
  if (!a || typeof a !== 'object') return null
  const region = a.region && typeof a.region === 'object' ? (a.region.region || a.region.region_code) : a.region
  return {
    name: text(a.name) || [a.firstname, a.lastname].filter(Boolean).map(text).join(' '),
    street: street(a.street),
    city: text(a.city),
    postcode: text(a.postcode),
    region: text(region),
    country: text(a.country || a.country_id)
  }
}

// App record has `lines` (sku, qty, ...), the module's has `items` (sku, qty). Sorted so order does not matter.
function normaliseLines (record) {
  const raw = Array.isArray(record.lines) ? record.lines : (Array.isArray(record.items) ? record.items : [])
  return raw
    .map(l => ({ sku: text(l.sku), qty: Number(l.qty ?? l.qty_ordered ?? 0) }))
    .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : a.qty - b.qty))
}

function normaliseRecord (record) {
  if (!record) return null
  return {
    lines: normaliseLines(record),
    address: normaliseAddress(record.shippingAddress || record.shipping_address),
    receivedAt: record.receivedAt || null
  }
}

const lineKey = l => `${l.sku} x${l.qty}`

// Lines only one side has (a changed qty shows up as one line on each side).
function diffLines (app, mod) {
  const count = list => list.reduce((m, l) => m.set(lineKey(l), (m.get(lineKey(l)) || 0) + 1), new Map())
  const a = count(app)
  const m = count(mod)
  const out = []
  for (const [k, n] of a) for (let i = 0; i < n - (m.get(k) || 0); i++) out.push(`only app: ${k}`)
  for (const [k, n] of m) for (let i = 0; i < n - (a.get(k) || 0); i++) out.push(`only module: ${k}`)
  return out
}

function diffAddress (app, mod) {
  if (!app && !mod) return []
  if (!app) return ['app has no address']
  if (!mod) return ['module has no address']
  return Object.keys(app)
    .filter(k => app[k] !== mod[k])
    .map(k => `${k}: app=${JSON.stringify(app[k])} module=${JSON.stringify(mod[k])}`)
}

// Module receivedAt minus app receivedAt, in ms (positive: the module's record arrived later).
function receivedDiffMs (app, mod) {
  const a = Date.parse(app && app.receivedAt)
  const m = Date.parse(mod && mod.receivedAt)
  return Number.isNaN(a) || Number.isNaN(m) ? null : m - a
}

function compareOrder (appRecord, moduleRecord) {
  const app = normaliseRecord(appRecord)
  const mod = normaliseRecord(moduleRecord)
  return {
    app: !!app,
    module: !!mod,
    lineDiffs: app && mod ? diffLines(app.lines, mod.lines) : [],
    addressDiffs: app && mod ? diffAddress(app.address, mod.address) : [],
    receivedDiffMs: app && mod ? receivedDiffMs(app, mod) : null
  }
}

function formatOrder (id, r) {
  const lines = [`order ${id}: app ${r.app ? 'present' : 'ABSENT'}, module ${r.module ? 'present' : 'ABSENT'}`]
  if (r.app && r.module) {
    lines.push(`  lines: ${r.lineDiffs.length ? '' : 'same'}`)
    r.lineDiffs.forEach(d => lines.push(`    ${d}`))
    lines.push(`  address: ${r.addressDiffs.length ? '' : 'same'}`)
    r.addressDiffs.forEach(d => lines.push(`    ${d}`))
    lines.push(`  receivedAt (module - app): ${r.receivedDiffMs === null ? 'n/a' : r.receivedDiffMs + ' ms'}`)
  }
  return lines.join('\n')
}

// 404 means "not there"; any other failure stops the run with the status (never the body or the key).
async function fetchRecord (base, key, order, fetchFn) {
  const res = await fetchFn(`${base.replace(/\/$/, '')}/orders?order=${encodeURIComponent(order)}`, {
    headers: { Authorization: `Bearer ${key}` }
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ?order=${order} answered ${res.status}`)
  return res.json()
}

async function run ({ url, key, ids }, fetchFn = fetch, out = console.log) {
  for (const [i, id] of ids.entries()) {
    const [app, mod] = [await fetchRecord(url, key, id, fetchFn), await fetchRecord(url, key, `module-${id}`, fetchFn)]
    // Both records 404 for the first id: more likely a wrong --url than two missing orders.
    if (i === 0 && !app && !mod) throw new Error(`both records are 404 for ${id}: check --url`)
    out(formatOrder(id, compareOrder(app, mod)))
  }
}

function parseArgs (argv) {
  const opts = { url: '', key: '', ids: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') opts.url = argv[++i] || ''
    else if (argv[i] === '--key') opts.key = argv[++i] || ''
    else opts.ids.push(argv[i])
  }
  return opts
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.url || !opts.key || !opts.ids.length) {
    console.error('Usage: node scripts/compare-erp.js --url <fake-erp base> --key <api key> <increment_id>...')
    process.exit(2)
  }
  run(opts).catch(e => { console.error(e.message); process.exit(1) })
}

module.exports = { normaliseRecord, normaliseAddress, normaliseLines, diffLines, diffAddress, receivedDiffMs, compareOrder, formatOrder, parseArgs, run }
