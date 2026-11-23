/*
 * Ep 9: the App Management config (Admin UI SDK V2). One menu entry, same place as V1 (no parentMenu: under Apps).
 * Layout copied from Adobe's sample adobe-commerce-samples/admin-ui-sdk/v2/menu/custom-menu.
 * `npx aio-commerce-lib-app generate all` turns this into src/commerce-extensibility-1/.generated/.
 */

import { defineConfig } from "@adobe/aio-commerce-lib-app/config";

export default defineConfig({
  metadata: {
    description: "Open stuck-order alerts and export deliveries",
    displayName: "Stuck orders",
    id: "stuck-orders",
    version: "1.0.0",
  },
  adminUi: {
    menu: {
      description: "Open stuck-order alerts and export deliveries",
      id: "StuckOrders::stuck",
      label: "Stuck orders",
      pageTitle: "Stuck orders",
    },
  },
});
