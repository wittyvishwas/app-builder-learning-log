const { sendOrder } = require('../actions/order-sync/erp')
const { scriptedFetch } = require('./helpers')

const erp = { url: 'https://erp.example/api/', apiKey: 'k', baseDelayMs: 0 }
const erpOrder = { orderNumber: '000000201', lines: [] }

test('POSTs to /orders with bearer auth and the order number as Idempotency-Key', async () => {
  global.fetch = scriptedFetch([201])
  await expect(sendOrder(erpOrder, erp)).resolves.toEqual({ status: 201, duplicate: false })
  const [url, opts] = global.fetch.mock.calls[0]
  expect(url).toBe('https://erp.example/api/orders')
  expect(opts.headers).toMatchObject({ Authorization: 'Bearer k', 'Idempotency-Key': '000000201' })
  expect(JSON.parse(opts.body).orderNumber).toBe('000000201')
})

test('409 means the ERP already has the order: success', async () => {
  global.fetch = scriptedFetch([409])
  await expect(sendOrder(erpOrder, erp)).resolves.toEqual({ status: 409, duplicate: true })
})

test('retries network errors, 429 and 5xx, then succeeds', async () => {
  global.fetch = scriptedFetch(['network', 503, 201])
  await expect(sendOrder(erpOrder, erp)).resolves.toMatchObject({ status: 201 })
  expect(global.fetch).toHaveBeenCalledTimes(3)
})

test('gives up after the last attempt with a transient error', async () => {
  global.fetch = scriptedFetch([429])
  await expect(sendOrder(erpOrder, erp)).rejects.toMatchObject({ status: 429, transient: true })
  expect(global.fetch).toHaveBeenCalledTimes(3)
})

test('does not retry a 4xx: it is permanent', async () => {
  global.fetch = scriptedFetch([422])
  await expect(sendOrder(erpOrder, erp)).rejects.toMatchObject({ status: 422, transient: false })
  expect(global.fetch).toHaveBeenCalledTimes(1)
})
