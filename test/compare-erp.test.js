const {
  normaliseRecord, diffLines, diffAddress, compareOrder, formatOrder, parseArgs, run
} = require('../scripts/compare-erp')

const app = {
  orderNumber: '000000201',
  receivedAt: '2026-11-18T10:00:00.000Z',
  currency: '',
  lines: [
    { sku: 'B', name: 'b', qty: 2, unitPrice: 5, rowTotal: 10 },
    { sku: 'A', name: 'a', qty: 1, unitPrice: 3, rowTotal: 3 }
  ],
  shippingAddress: { name: 'Ann Lee', street: 'Main 1\nFlat 2', city: 'Paris', postcode: '75001', region: '', country: 'FR' }
}
const mod = {
  orderNumber: 'module-000000201',
  increment_id: '000000201',
  receivedAt: '2026-11-18T10:00:00.250Z',
  items: [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2.0 }],
  shipping_address: { firstname: 'Ann', lastname: 'Lee', street: ['Main 1', 'Flat 2'], city: 'Paris', postcode: '75001', region: '', country_id: 'FR' }
}

test('both shapes normalise to the same sorted lines and address', () => {
  const a = normaliseRecord(app)
  const m = normaliseRecord(mod)
  expect(a.lines).toEqual([{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2 }])
  expect(m.lines).toEqual(a.lines)
  expect(m.address).toEqual(a.address)
  expect(a.address).toEqual({ name: 'Ann Lee', street: 'Main 1\nFlat 2', city: 'Paris', postcode: '75001', region: '', country: 'FR' })
})

test('a record with no lines or address normalises to empty, a missing record to null', () => {
  expect(normaliseRecord({})).toEqual({ lines: [], address: null, receivedAt: null })
  expect(normaliseRecord(null)).toBeNull()
  expect(normaliseRecord({ shipping_address: { region: { region: 'Bavaria' } } }).address.region).toBe('Bavaria')
})

test('matching orders: no differences, receivedAt difference in ms', () => {
  expect(compareOrder(app, mod)).toEqual({ app: true, module: true, lineDiffs: [], addressDiffs: [], receivedDiffMs: 250 })
})

test('line differences name the side that has the line', () => {
  const r = compareOrder(app, { ...mod, items: [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 3 }, { sku: 'C', qty: 1 }] })
  expect(r.lineDiffs.sort()).toEqual(['only app: B x2', 'only module: B x3', 'only module: C x1'])
  expect(diffLines([{ sku: 'A', qty: 1 }, { sku: 'A', qty: 1 }], [{ sku: 'A', qty: 1 }])).toEqual(['only app: A x1'])
})

test('address differences list the fields', () => {
  const r = compareOrder(app, { ...mod, shipping_address: { ...mod.shipping_address, city: 'Lyon' } })
  expect(r.addressDiffs).toEqual(['city: app="Paris" module="Lyon"'])
  expect(diffAddress(null, { city: 'x' })).toEqual(['app has no address'])
  expect(diffAddress({ city: 'x' }, null)).toEqual(['module has no address'])
})

test('an absent sender is reported and nothing else is compared', () => {
  expect(compareOrder(app, null)).toEqual({ app: true, module: false, lineDiffs: [], addressDiffs: [], receivedDiffMs: null })
  expect(formatOrder('1', compareOrder(null, null))).toBe('order 1: app ABSENT, module ABSENT')
  expect(formatOrder('201', compareOrder(app, mod))).toContain('receivedAt (module - app): 250 ms')
})

test('parseArgs reads url, key and ids', () => {
  expect(parseArgs(['--url', 'https://x/y', '--key', 'k', '1', '2'])).toEqual({ url: 'https://x/y', key: 'k', ids: ['1', '2'] })
})

test('run fetches both records per id with the bearer key and prints a block per order', async () => {
  const calls = []
  const fetchFn = async (url, opts) => {
    calls.push([url, opts.headers.Authorization])
    if (url.endsWith('order=000000201')) return { status: 200, ok: true, json: async () => app }
    if (url.endsWith('order=module-000000201')) return { status: 200, ok: true, json: async () => mod }
    return { status: 404, ok: false }
  }
  const out = []
  await run({ url: 'https://erp/web/', key: 'secret', ids: ['000000201', '000000202'] }, fetchFn, s => out.push(s))
  expect(calls.map(c => c[0])).toEqual([
    'https://erp/web/orders?order=000000201',
    'https://erp/web/orders?order=module-000000201',
    'https://erp/web/orders?order=000000202',
    'https://erp/web/orders?order=module-000000202'
  ])
  expect(calls.every(c => c[1] === 'Bearer secret')).toBe(true)
  expect(out[0]).toContain('app present, module present')
  expect(out[1]).toBe('order 000000202: app ABSENT, module ABSENT')
})

test('run stops with the status on an unexpected answer, without the key', async () => {
  const fetchFn = async () => ({ status: 401, ok: false })
  await expect(run({ url: 'https://erp', key: 'secret', ids: ['1'] }, fetchFn, () => {})).rejects.toThrow('answered 401')
})

test('run stops with "check --url" when both records of the first id are 404', async () => {
  const out = []
  await expect(run({ url: 'https://wrong', key: 'k', ids: ['1', '2'] }, async () => ({ status: 404, ok: false }), s => out.push(s)))
    .rejects.toThrow('check --url')
  expect(out).toEqual([])
})
