jest.mock('@adobe/aio-sdk', () => ({
  Core: { Logger: () => ({ info: () => {}, error: () => {} }) }
}))
const { main } = require('../actions/export-order')

test('400 when ERP_API_URL is missing', async () => {
  const res = await main({})
  expect(res.error.statusCode).toBe(400)
  expect(res.error.body.error).toBe("missing parameter 'ERP_API_URL'")
})

test('200 when inputs are present', async () => {
  expect(await main({ ERP_API_URL: 'https://erp.example/' })).toEqual({ statusCode: 200, body: { ok: true } })
})
