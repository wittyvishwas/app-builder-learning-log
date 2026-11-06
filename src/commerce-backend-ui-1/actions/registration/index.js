/*
 * Ep 9: the Admin UI SDK v1 registration, shaped like Adobe's custom-menu sample: menuItems
 * (id, title, parent, sortOrder; the parent entry is a section with isSection: true) and a page title.
 * The sample's "Apps" section is kept as is, so "Stuck orders" sits under Apps and no new section is added.
 * The extension id must match web-src/src/components/Constants.js.
 */
async function main () {
  const extensionId = 'StuckOrders'

  return {
    statusCode: 200,
    body: {
      registration: {
        menuItems: [
          {
            id: `${extensionId}::stuck`,
            title: 'Stuck orders',
            parent: `${extensionId}::apps`,
            sortOrder: 1
          },
          {
            id: `${extensionId}::apps`,
            title: 'Apps',
            isSection: true,
            sortOrder: 100
          }
        ],
        page: {
          title: 'Stuck orders'
        }
      }
    }
  }
}

exports.main = main
