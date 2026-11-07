/* The fakeDb must not be more forgiving than the real service, or tests prove nothing. */
const { fakeDb } = require('./helpers')

test('updateOne rejects update operators the fake does not implement', async () => {
  const c = fakeDb(new Map([['c', [{ a: 1 }]]])).client.collection('c')
  await expect(c.updateOne({ a: 1 }, { $inc: { n: 1 } })).rejects.toThrow('unsupported update operator $inc')
  await expect(c.updateMany({ a: 1 }, { $unset: { a: '' } })).rejects.toThrow('unsupported update operator $unset')
})

test('$setOnInsert applies on upsert only', async () => {
  const db = fakeDb()
  const c = db.client.collection('c')
  await c.updateOne({ order: '1' }, { $set: { handled: false }, $setOnInsert: { created_at: 'x' } }, { upsert: true })
  await c.updateOne({ order: '1' }, { $set: { handled: true }, $setOnInsert: { created_at: 'y' } }, { upsert: true })
  expect(db.data.get('c')).toEqual([{ order: '1', handled: true, created_at: 'x' }])
})

test('a unique index over existing duplicates throws', async () => {
  const c = fakeDb(new Map([['c', [{ order: '1' }, { order: '1' }]]])).client.collection('c')
  await expect(c.createIndex({ order: 1 }, { unique: true })).rejects.toThrow('duplicates exist')
  await expect(c.createIndex({ order: 1 })).resolves.toBe('order_1')
})

test('an upsert seeds the inserted document from equality fields in $and and a single-clause $or, not a multi-clause $or', async () => {
  const db = fakeDb()
  const c = db.client.collection('c')
  await c.updateOne({ $and: [{ order: '1' }, { kind: 'a', n: { $lt: 5 } }] }, { $set: { x: 1 } }, { upsert: true })
  await c.updateOne({ order: '2', $or: [{ status: 'failed' }] }, { $set: { x: 1 } }, { upsert: true })
  await c.updateOne({ order: '3', $or: [{ status: 'failed' }, { status: 'sending' }] }, { $set: { x: 1 } }, { upsert: true })
  expect(db.data.get('c')).toEqual([
    { order: '1', kind: 'a', x: 1 },
    { order: '2', status: 'failed', x: 1 },
    { order: '3', x: 1 }
  ])
})

test('a top-level $ key other than $or and $and is rejected, even when nothing could match', async () => {
  const c = fakeDb(new Map([['c', [{ a: 1 }]]])).client.collection('c')
  await expect(c.findOne({ $nor: [{ a: 1 }] })).rejects.toThrow('unsupported operator $nor')
  await expect(c.updateOne({ $nor: [{ a: 1 }] }, { $set: { x: 1 } }, { upsert: true })).rejects.toThrow('unsupported operator $nor')
  await expect(fakeDb().client.collection('e').updateOne({ $nor: [] }, { $set: { x: 1 } }, { upsert: true })).rejects.toThrow('unsupported operator $nor')
})

test('failOn can name one collection or one call of it', async () => {
  const db = fakeDb(new Map(), { failOn: ['a.insertOne', 'b.insertOne#2'] })
  await expect(db.client.collection('a').insertOne({ x: 1 })).rejects.toThrow('insertOne failed')
  const b = db.client.collection('b')
  await b.insertOne({ x: 1 })
  await expect(b.insertOne({ x: 2 })).rejects.toThrow('insertOne failed')
  await b.insertOne({ x: 3 })
  expect(db.data.get('b')).toEqual([{ x: 1 }, { x: 3 }])
})
