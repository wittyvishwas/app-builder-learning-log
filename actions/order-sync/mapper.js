/*
 * Map a Commerce order (the `data.value` of an I/O Events `observer.sales_order_place_after`
 * event, or a REST order) to the ERP's order shape. Pure function: no I/O, easy to test.
 * The ERP shape here is generic; change this file, not the delivery code, for your ERP.
 */

function money (v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

function lines (items = []) {
  return items
    // Configurable and bundle parents carry the price; their simple children repeat the SKU at price 0.
    .filter(i => !i.parent_item_id && !i.parent_item)
    .map(i => ({
      sku: String(i.sku),
      name: i.name || '',
      qty: Number(i.qty_ordered ?? i.qty ?? 0),
      unitPrice: money(i.price),
      rowTotal: money(i.row_total ?? Number(i.price) * Number(i.qty_ordered ?? i.qty ?? 0))
    }))
}

function address (a) {
  if (!a) return null
  return {
    name: [a.firstname, a.lastname].filter(Boolean).join(' '),
    street: Array.isArray(a.street) ? a.street.join('\n') : (a.street || ''),
    city: a.city || '',
    postcode: a.postcode || '',
    region: a.region || '',
    country: a.country_id || ''
  }
}

function toErpOrder (order) {
  if (!order || !order.increment_id) {
    throw new Error('order has no increment_id')
  }
  const shipping = order.extension_attributes?.shipping_assignments?.[0]?.shipping?.address ||
    order.shipping_address ||
    (order.addresses || []).find(a => a.address_type === 'shipping')
  return {
    orderNumber: String(order.increment_id),
    placedAt: order.created_at || null,
    currency: order.order_currency_code || order.base_currency_code || '',
    total: money(order.grand_total),
    shippingAmount: money(order.shipping_amount),
    taxAmount: money(order.tax_amount),
    customer: {
      email: order.customer_email || '',
      name: [order.customer_firstname, order.customer_lastname].filter(Boolean).join(' ')
    },
    billingAddress: address(order.billing_address || (order.addresses || []).find(a => a.address_type === 'billing')),
    shippingAddress: address(shipping),
    lines: lines(order.items)
  }
}

module.exports = { toErpOrder }
