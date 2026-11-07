/* Shared fakes: an in-memory State with list() support, a scripted fetch and an in-memory aio-lib-db. */
function fakeState (store, { pages = 1, duplicate = false, ttls = new Map() } = {}) {
  return {
    get: async k => (store.has(k) ? { value: store.get(k) } : undefined),
    // Like aio-lib-state 5.4: with ifNotExists, an existing key is left alone and put resolves to null.
    put: async (k, v, opts = {}) => {
      if (opts.ifNotExists && store.has(k)) return null
      store.set(k, v)
      ttls.set(k, opts.ttl)
      return k
    },
    delete: async k => { const had = store.delete(k); return had ? k : null },
    // Like the real cursor scan: keys come in pages, and (with duplicate) a key can show up twice.
    list: ({ match }) => {
      const re = new RegExp('^' + match.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$')
      const keys = [...store.keys()].filter(k => re.test(k))
      const size = Math.max(1, Math.ceil(keys.length / pages))
      return (async function * () {
        for (let i = 0; i < keys.length; i += size) yield { keys: keys.slice(i, i + size) }
        if (duplicate && keys.length) yield { keys: [keys[0]] }
      })()
    }
  }
}

// Like aio-lib-db: every failure is a DbError (e.name === 'DbError').
class DbError extends Error {
  constructor (message) { super(message); this.name = 'DbError' }
}

const OPS = {
  $ne: (v, x) => !same(v, x),
  $in: (v, x) => x.some(y => same(v, y)),
  $lt: (v, x) => v !== undefined && v !== null && v < x,
  $lte: (v, x) => v !== undefined && v !== null && v <= x,
  $gt: (v, x) => v !== undefined && v !== null && v > x,
  $gte: (v, x) => v !== undefined && v !== null && v >= x
}
// Update operators the fake knows; anything else throws instead of being silently ignored.
function applyUpdate (doc, update, inserting) {
  for (const op of Object.keys(update)) {
    if (op !== '$set' && op !== '$setOnInsert') throw new DbError(`fakeDb: unsupported update operator ${op}`)
  }
  // Mongo rejects an update that touches the same field in $set and $setOnInsert.
  for (const k of Object.keys(update.$set || {})) {
    if (k in (update.$setOnInsert || {})) throw new DbError(`fakeDb: conflicting update operators on ${k}`)
  }
  Object.assign(doc, update.$set)
  if (inserting) Object.assign(doc, update.$setOnInsert)
  return doc
}
// Mongo-style equality: null also matches a missing field.
const same = (v, x) => (x === null ? v === null || v === undefined : v === x)
const isOps = c => c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).some(k => k.startsWith('$'))

function matches (doc, filter = {}) {
  return Object.entries(filter).every(([field, cond]) => {
    if (field.startsWith('$') && field !== '$or' && field !== '$and') throw new DbError(`fakeDb: unsupported operator ${field}`)
    if (field === '$or') return cond.some(f => matches(doc, f))
    if (field === '$and') return cond.every(f => matches(doc, f))
    const v = doc[field]
    if (!isOps(cond)) return same(v, cond)
    return Object.entries(cond).every(([op, x]) => {
      if (!OPS[op]) throw new DbError(`fakeDb: unsupported operator ${op}`)
      return OPS[op](v, x)
    })
  })
}

// The document an upsert inserts starts from the filter's equality fields, like MongoDB: top-level ones, those
// inside $and, and those of a $or with a single clause. A $or with several clauses adds nothing.
function upsertSeed (filter) {
  const doc = {}
  for (const [field, cond] of Object.entries(filter)) {
    if (field === '$and') cond.forEach(f => Object.assign(doc, upsertSeed(f)))
    else if (field === '$or') { if (cond.length === 1) Object.assign(doc, upsertSeed(cond[0])) }
    else if (field.startsWith('$')) throw new DbError(`fakeDb: unsupported operator ${field}`)
    else if (!isOps(cond)) doc[field] = cond
  }
  return doc
}

// An in-memory aio-lib-db for tests. `data` maps collection name to an array of documents.
// opts.failOn: method names (insertOne, find, createIndex, ...) that throw a DbError, or connect/close.
// An entry can name one collection ('order_claims.updateOne') or one call of it ('order_claims.updateOne#2').
// Returns the module-shaped object (init) plus inspection helpers: calls, data, client.
function fakeDb (data = new Map(), { failOn = [] } = {}) {
  const calls = { init: [], connect: 0, close: 0 }
  const indexes = new Map() // collection -> [{ name, key, unique }]
  const seen = new Map()
  const fail = (op, coll) => {
    const key = coll && `${coll}.${op}`
    const n = key ? (seen.set(key, (seen.get(key) || 0) + 1), seen.get(key)) : 0
    if (failOn.includes(op) || (key && (failOn.includes(key) || failOn.includes(`${key}#${n}`)))) throw new DbError(`fakeDb: ${op} failed`)
  }
  const rows = name => { if (!data.has(name)) data.set(name, []); return data.get(name) }
  const idxOf = name => {
    if (!indexes.has(name)) indexes.set(name, [{ name: '_id_', key: { _id: 1 }, unique: true }])
    return indexes.get(name)
  }
  const checkUnique = (name, doc, ignore) => {
    for (const ix of idxOf(name).filter(i => i.unique && i.name !== '_id_')) {
      const keys = Object.keys(ix.key)
      if (rows(name).some(r => r !== ignore && keys.every(k => r[k] === doc[k]))) {
        throw new DbError(`fakeDb: E11000 duplicate key error on ${name}.${ix.name}`)
      }
    }
  }

  const collection = name => {
    const insert = doc => { checkUnique(name, doc); rows(name).push(doc) }
    return {
      insertOne: async doc => { fail('insertOne', name); insert({ ...doc }); return { insertedId: rows(name).length } },
      insertMany: async docs => { fail('insertMany', name); docs.forEach(d => insert({ ...d })); return { insertedCount: docs.length } },
      findOne: async (filter = {}) => { fail('findOne', name); const d = rows(name).find(r => matches(r, filter)); return d ? { ...d } : null },
      find: (filter = {}) => {
        fail('find', name)
        let sortSpec = null
        let max = Infinity
        const cursor = {
          sort: spec => { sortSpec = spec; return cursor },
          limit: n => { max = n; return cursor },
          toArray: async () => {
            let out = rows(name).filter(r => matches(r, filter)).map(r => ({ ...r }))
            if (sortSpec) {
              const keys = Object.entries(sortSpec)
              out = out.sort((a, b) => {
                for (const [k, dir] of keys) if (a[k] !== b[k]) return (a[k] < b[k] ? -1 : 1) * dir
                return 0
              })
            }
            return out.slice(0, max)
          }
        }
        return cursor
      },
      updateOne: async (filter, update, { upsert = false } = {}) => {
        fail('updateOne', name)
        const doc = rows(name).find(r => matches(r, filter))
        if (doc) { checkUnique(name, applyUpdate({ ...doc }, update, false), doc); applyUpdate(doc, update, false); return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 } }
        if (!upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 }
        const plain = upsertSeed(filter)
        insert(applyUpdate({ ...plain }, update, true))
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
      },
      updateMany: async (filter, update, { upsert = false } = {}) => {
        fail('updateMany', name)
        const docs = rows(name).filter(r => matches(r, filter))
        docs.forEach(d => applyUpdate(d, update, false))
        if (!docs.length && upsert) {
          const plain = upsertSeed(filter)
          insert(applyUpdate({ ...plain }, update, true))
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 }
        }
        return { matchedCount: docs.length, modifiedCount: docs.length, upsertedCount: 0 }
      },
      deleteOne: async filter => {
        fail('deleteOne', name)
        const i = rows(name).findIndex(r => matches(r, filter))
        if (i >= 0) rows(name).splice(i, 1)
        return { deletedCount: i >= 0 ? 1 : 0 }
      },
      countDocuments: async (filter = {}) => { fail('countDocuments', name); return rows(name).filter(r => matches(r, filter)).length },
      createIndex: async (spec, options = {}) => {
        fail('createIndex', name)
        const ixName = options.name || Object.entries(spec).map(([k, v]) => `${k}_${v}`).join('_')
        if (options.unique) {
          const seen = new Set()
          for (const r of rows(name)) {
            const k = JSON.stringify(Object.keys(spec).map(f => r[f]))
            if (seen.has(k)) throw new DbError(`fakeDb: cannot create unique index ${ixName}, duplicates exist`)
            seen.add(k)
          }
        }
        if (!idxOf(name).some(i => i.name === ixName)) idxOf(name).push({ name: ixName, key: spec, unique: !!options.unique })
        return ixName
      },
      getIndexes: async () => { fail('getIndexes', name); return idxOf(name).map(i => ({ ...i })) }
    }
  }

  const client = {
    collection: name => collection(name),
    close: async () => { calls.close++; fail('close') }
  }
  const db = { connect: async () => { calls.connect++; fail('connect'); return client } }
  return {
    init: async opts => { calls.init.push(opts); fail('init'); return db },
    client, calls, data, indexes
  }
}

// responses: array of numbers (HTTP status) or 'network' (throws), consumed in order; last one repeats.
function scriptedFetch (responses) {
  const queue = [...responses]
  return jest.fn(async () => {
    const r = queue.length > 1 ? queue.shift() : queue[0]
    if (r === 'network') throw new Error('ECONNRESET')
    return { ok: r >= 200 && r < 300, status: r, text: async () => `status ${r}` }
  })
}

const order = {
  increment_id: '000000201',
  created_at: '2027-01-14 10:00:00',
  order_currency_code: 'EUR',
  grand_total: '119.9',
  shipping_amount: '5',
  tax_amount: '19.14',
  customer_email: 'jane@example.com',
  customer_firstname: 'Jane',
  customer_lastname: 'Doe',
  billing_address: { firstname: 'Jane', lastname: 'Doe', street: ['1 Main St', 'Flat 2'], city: 'Berlin', postcode: '10115', country_id: 'DE' },
  items: [
    { item_id: 1, sku: 'TSHIRT-M', name: 'T-shirt', qty_ordered: 2, price: '29.95', row_total: '59.9' },
    { item_id: 2, parent_item_id: 1, sku: 'TSHIRT-M', name: 'T-shirt', qty_ordered: 2, price: '0' },
    { item_id: 3, sku: 'MUG', name: 'Mug', qty_ordered: 1, price: '55', row_total: '55' }
  ]
}

module.exports = { fakeState, fakeDb, DbError, scriptedFetch, order }
