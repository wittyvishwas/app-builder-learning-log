# MageMinion_CartCheck

The Ep 7 webhook as a ready-made module: `etc/webhooks.xml` declares the `restricted_sku` hook on `observer.checkout_cart_product_add_before`. Its rule means it fires only for SKUs matching `/^MMTEST-/`, so a push to a shared staging never touches real shoppers. Remove the rule for real use. Needs `Magento_AdobeCommerceWebhooks` (the module sequence loads it first).

## Install (Adobe Commerce on cloud infrastructure)

```bash
cp -r commerce/CartCheck <magento root>/app/code/MageMinion/CartCheck
bin/magento module:enable MageMinion_CartCheck     # writes app/etc/config.php
```

1. Commit the module and `app/etc/config.php`.
2. On the deploying branch, confirm `.magento.env.yaml` has `ENABLE_WEBHOOKS: true` under `stage: global:`.
3. Set the Cloud project variables the `webhooks.xml` reads: `env:CART_CHECK_URL` (the web URL of `webhooks/cart-check`), and for the scratch variants `env:CART_CHECK_SCRATCH_URL`.
4. Push. Webhook plugins are generated at build, so every `webhooks.xml` change is a push and a redeploy.

The run variants (A, B, C) are in `dev/run-ep7/`; see its README.
