# MageMinion_CartCheck

The Ep 7 webhook as a ready-made module: `etc/webhooks.xml` declares the `restricted_sku` hook on `observer.sales_quote_add_item` (field `product.sku` from `data.quote_item.sku`). That event is dispatched in `Quote::addItem()`, which every way of adding to a cart uses. GraphQL `addProductsToCart` and REST `POST /V1/guest-carts/{id}/items` were verified blocked on Stage; the storefront follows from the source and was not run with this hook. `observer.checkout_cart_product_add_before` runs only in the storefront controller, so GraphQL and REST skip it (checked on Adobe Commerce 2.4.8-p5). Its rule means it fires only for SKUs matching `/^MMTEST-/`, so a push to a shared staging never touches real shoppers. Remove the rule for real use. Needs `Magento_AdobeCommerceWebhooks` (the module sequence loads it first).

## Install (Adobe Commerce on cloud infrastructure)

```bash
cp -r commerce/CartCheck <magento root>/app/code/MageMinion/CartCheck
bin/magento module:enable MageMinion_CartCheck     # writes app/etc/config.php
```

1. Commit the module and `app/etc/config.php`.
2. On the deploying branch, confirm `.magento.env.yaml` has `ENABLE_WEBHOOKS: true` under `stage: global:`.
3. Set `RESTRICTED_SKUS` in the action's `.env` (comma-separated); the action blocks only SKUs on that list, and with it unset everything is allowed. Redeploy the app.
4. Set the Cloud project variables the `webhooks.xml` reads: `env:CART_CHECK_URL` (the web URL of `webhooks/cart-check`), and for the scratch variants `env:CART_CHECK_SCRATCH_URL`.
5. Push. Webhook plugins are generated at build, so every `webhooks.xml` change is a push and a redeploy.

The run variants (A, B, C) are in `dev/run-ep7/`; see its README.
