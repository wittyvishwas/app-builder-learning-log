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

test('updateOne rejects the same field in $set and $setOnInsert, like Mongo', async () => {
  const db = fakeDb()
  const c = db.client.collection('c')
  await expect(c.updateOne({ a: 1 }, { $set: { x: 1 }, $setOnInsert: { x: 2 } }, { upsert: true })).rejects.toThrow(/conflicting/)
})
