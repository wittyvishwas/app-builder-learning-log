const { toErpOrder } = require('../actions/order-sync/mapper')
const { order } = require('./helpers')

test('maps a Commerce order to the ERP shape', () => {
  const e = toErpOrder(order)
  expect(e).toMatchObject({
    orderNumber: '000000201',
    placedAt: '2027-01-14 10:00:00',
    currency: 'EUR',
    total: 119.9,
    shippingAmount: 5,
    taxAmount: 19.14,
    customer: { email: 'jane@example.com', name: 'Jane Doe' },
    billingAddress: { name: 'Jane Doe', street: '1 Main St\nFlat 2', city: 'Berlin', postcode: '10115', country: 'DE' }
  })
})

test('drops child items of configurable products, keeps parents', () => {
  expect(toErpOrder(order).lines).toEqual([
    { sku: 'TSHIRT-M', name: 'T-shirt', qty: 2, unitPrice: 29.95, rowTotal: 59.9 },
    { sku: 'MUG', name: 'Mug', qty: 1, unitPrice: 55, rowTotal: 55 }
  ])
})

test('takes the shipping address from extension attributes when present', () => {
  const o = { ...order, extension_attributes: { shipping_assignments: [{ shipping: { address: { firstname: 'Max', city: 'Hamburg', country_id: 'DE' } } }] } }
  expect(toErpOrder(o).shippingAddress).toMatchObject({ name: 'Max', city: 'Hamburg' })
})

test('refuses an order without increment_id', () => {
  expect(() => toErpOrder({ grand_total: 1 })).toThrow('order has no increment_id')
})
