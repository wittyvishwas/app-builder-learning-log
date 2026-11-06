/* Shared fakes: an in-memory State with list() support and a scripted fetch. */
function fakeState (store) {
  return {
    get: async k => (store.has(k) ? { value: store.get(k) } : undefined),
    put: async (k, v) => { store.set(k, v); return k },
    delete: async k => { store.delete(k); return k },
    list: ({ match }) => {
      const re = new RegExp('^' + match.replace(/[.]/g, '\\.').replace(/\*/g, '.*') + '$')
      const keys = [...store.keys()].filter(k => re.test(k))
      return (async function * () { yield { keys } })()
    }
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

module.exports = { fakeState, scriptedFetch, order }
