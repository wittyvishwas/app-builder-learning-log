# Agent hand-off: App Builder Ep 7, replace a plugin with a webhook

Give this file to your coding agent (Claude Code or similar) inside your own App Builder project. It builds what Ep 7 built, in your project. Post: <https://mageminion.com/app-builder-ep7-webhooks/>. Code: tag `ep7-webhooks` in https://github.com/wittyvishwas/app-builder-learning-log.

Goal: an App Builder web action that Adobe Commerce calls before an item is added to a cart. It checks the call is signed by Commerce, then answers `success`, or `exception` with a message for a restricted SKU.

## Before you start
- Builds on Ep 1 (project layout, `.env` out of git). Ep 6 is the same family (events) but is not required.
- The human must have:
  - Adobe Developer Console access, `aio login` done, a non-Production workspace selected (`aio where`).
  - Adobe Commerce with webhooks available. On PaaS: the webhooks module installed as [Adobe's installation guide](https://developer.adobe.com/commerce/extensibility/webhooks/installation/) describes. On Commerce as a Cloud Service: webhooks are managed in the admin.
  - A place for a small Commerce module (PaaS), to hold `webhooks.xml`.
- Agent: stop and ask the human for anything in this list you can't confirm.

## Rules for the agent
- Never use a Production workspace. Never deploy without the human's yes.
- Before any `aio app deploy`, `aio app use` or onboarding script, run `aio where` and show the human the workspace. Continue only on their yes.
- Never write secret values to files under git; `.env` and `.aio` stay out of git. The public key goes in `.env` only.
- The action must answer in well under a second: Commerce waits for it inside the customer's request. Do not add slow calls to it.
- You can't reach Commerce. The Commerce admin and `bin/magento` steps are the human's.
- Build only what this file lists. Keep the reader's existing names and code style; rename the episode's names (listed below) to fit.
- Hook `observer.sales_quote_add_item`, not `observer.checkout_cart_product_add_before`. The second runs only in the storefront cart controller. GraphQL `addProductsToCart` and REST `POST /V1/guest-carts/{id}/items` skip it.

## Get the reference code
```bash
[ -d /tmp/abl ] || git clone https://github.com/wittyvishwas/app-builder-learning-log /tmp/abl
git -C /tmp/abl fetch --tags
# then, for each Files row: git -C /tmp/abl show REF:PATH
```
No row needs a later ref: `git log` shows no change after the tag to the Ep 7 files below. The README on `main` has the current verified list.

## Files
| Path | Ref | What it is | Do |
|---|---|---|---|
| `actions/cart-check/index.js` | `ep7-webhooks` | The webhook action. Verifies Commerce's signature over the base64 body, reads `product.sku`, answers `success`, or `exception` with a message when the SKU is in `RESTRICTED_SKUS`. A missing key answers 500; a bad signature answers `exception`. Fuller than the post's snippet (PEM with escaped `\n`, no body or key in logs). | add |
| `commerce/webhooks.xml` | `ep7-webhooks` | The hook declaration. On PaaS it belongs in a small module's `etc/webhooks.xml`. | add into a Commerce module (the human's repo), not this project |
| `test/cart-check.test.js` | `ep7-webhooks` | Tests with real RSA keys: tampered body, base64 body, JSON-text body, escaped-newline PEM, missing key, missing SKU, restricted-SKU list. | add |

## Config
- `app.config.yaml`, a new package with the action. It is a web action with `raw-http: true`, because the signature check needs the raw body:
  ```yaml
  webhooks:
    license: Apache-2.0
    actions:
      cart-check:
        function: actions/cart-check/index.js
        runtime: nodejs:20
        web: 'yes'
        inputs:
          LOG_LEVEL: info
          PUBLIC_KEY: $PUBLIC_KEY
          RESTRICTED_SKUS: $RESTRICTED_SKUS
        annotations:
          raw-http: true
          final: true
  ```
- `.env` keys, by name only:
  - `PUBLIC_KEY`: Commerce's public key for webhook signatures, on one line with `\n` for each line break. The human copies it from Commerce. Regenerating the key pair invalidates the old key at once, so update `.env` and redeploy in the same change.
  - `RESTRICTED_SKUS`: comma-separated SKUs to refuse (trimmed, case-sensitive). The human provides it. Unset, the action allows everything. The first run on Stage passed every SKU for exactly that reason: set it and redeploy before testing.
- Commerce side, `CART_CHECK_URL`: the URL of the deployed `cart-check` action. `webhooks.xml` reads it as `{env:CART_CHECK_URL}`. The human sets it in Commerce's environment after the deploy.
- Human steps in Commerce. The agent stops and asks the human to do these:
  1. Put `commerce/webhooks.xml` in a small module (PaaS), then `bin/magento setup:upgrade`, `bin/magento webhooks:list`, and `bin/magento webhooks:info observer.sales_quote_add_item --depth=4`. `webhooks:info` prints the payload Commerce sends. Use it to pick the `source` paths. The field `name` sets the shape the action gets: `name="product.sku"` arrives as `{ "product": { "sku": "..." } }`. In production mode run `bin/magento cache:clean config` after changes. Docs: [hooks](https://developer.adobe.com/commerce/extensibility/webhooks/hooks/). On Commerce as a Cloud Service, enter the same settings under **System > Webhooks** (the **Webhooks List** shows the methods you can hook).
  2. **Stores > Settings > Configuration > Adobe Services > Webhooks**: enable [digital signatures](https://developer.adobe.com/commerce/extensibility/webhooks/signature-verification/) and click **Regenerate key pair**. Commerce then signs each request in the `x-adobe-commerce-webhook-signature` header. The human puts the public key in `.env`.
  3. Optional: enable database logging in the same place, and read calls at **System > Webhooks > Webhook Logs**.
- The hook as declared in the reference: `timeout="2000" softTimeout="500" required="false"`. `required="false"` fails open: on a timeout or error Commerce logs it and carries on. `required="true"` fails closed. Decide per hook and write the reason in the module: fail open for nice-to-have checks, fail closed for legal or financial ones, with a short `timeout`, monitoring and an on-call owner. Ask the human which they want. See [the XML schema](https://developer.adobe.com/commerce/extensibility/webhooks/xml-schema/). `softTimeout` only logs a notice for a slow call.
- Response operations (JSON only, HTTP 200): `success`, `exception` (with `message`, or the hook's `fallbackErrorMessage`), `replace`, `add`, `remove`. This episode uses only the first two. See [responses](https://developer.adobe.com/commerce/extensibility/webhooks/responses/).

## Tests
- Add `test/cart-check.test.js`. It needs `jest` and Node's `crypto`. It needs no repo helpers.
- Run `npm test`. The signature tests use their own key pair, so they do not prove a real Commerce signs the same way.

## Check it works
1. Local: `npm test`. Do not rely on `aio app dev` for this action: it ignores the `raw-http: true` annotation (only `web: 'raw'` counts), so `cart-check` gets no `__ow_body` there and refuses every signed call.
2. On the non-Production workspace, after the human says yes to the deploy:
   1. `aio app deploy`, then `aio runtime action list` shows `webhooks/cart-check`. Give the human the action URL for `CART_CHECK_URL`.
   2. The human tests from Commerce with a payload trimmed from what `webhooks:info` printed. Give the method with the `:before` suffix, or the CLI says the webhook is not registered:
      ```bash
      bin/magento webhooks:dev:run observer.sales_quote_add_item:before '{"data":{"quote_item":{"sku":"RESTRICTED-1"}}}'
      ```
      `dev:run` applies the hook's rules and prints "The webhook was successfully processed." also when a rule skips the call. Only the activation list shows the difference: a skipped call leaves no activation.
   3. The human tries a restricted SKU through GraphQL `addProductsToCart` and REST `POST /V1/guest-carts/{id}/items`. GraphQL returns the message in `user_errors` with code `UNDEFINED` and an empty cart. REST returns HTTP 400 with the message. An allowed SKU goes in.
   4. Unhappy paths, one at a time: stop the action and add an item; make it slow; return invalid JSON. Each must match the fail-open or fail-closed choice. Add these cases to your own browser test suite if you have one.
- Not verified in the post: end-to-end checkout timing, the `required="true"` fail-closed behaviour, the exact message text on the storefront page, storefront add-to-cart with `observer.sales_quote_add_item` (it follows from the source), and whether a storefront add with both hooks registered fires twice.

## Names to rename
| In the reference | Why it may differ in yours |
|---|---|
| `webhooks/cart-check` | Your package and action name. `CART_CHECK_URL` must point at the deployed URL. |
| `CART_CHECK_URL`, `PUBLIC_KEY`, `RESTRICTED_SKUS` | Your own env names. Keep `app.config.yaml` and the action's `params` in step. |
| `restricted_sku`, `cart_rules`, `product.sku` | Hook, batch and field names in `webhooks.xml`. The field name must match what the action reads. |
| The `isAllowed` list check | The post says an external check, such as a restricted item or a regional rule. Replace it with your own rule and keep the signature check. |
| Messages | `This item can't be added to your cart.` and `We couldn't check this item. Please try again.` are examples. |

## Not in this episode
- Files present at this tag that belong to other episodes. Do not copy them:
  - `actions/order-placed/index.js`, `test/order-placed.test.js`: Commerce events (Ep 6).
  - `mesh/mesh.json`, `mesh/reviews-schema.json`, `test/mesh.test.js`: API Mesh (Ep 8).
  - `src/commerce-backend-ui-1/`: the Admin UI page (Ep 9) and its Ep 10 actions.
  - `actions/export-order/`, `actions/export-order-retry/`, `actions/order-sync/`, `commerce/OrderExport/`, `scripts/compare-erp.js`: order sync and the PHP module it is compared with (Ep 10).
  - `actions/stuck-orders/index.js`, `actions/sync-log/index.js`, `scripts/post-deploy-db-setup.js`: Ep 3 and Ep 4.
  - `commerce/CartCheck/`, `dev/run-ep7/`, `actions/fake-erp/`, `test/cart-check-scratch.test.js`: the author's Commerce-side run kit and scratch action for the Stage run. Not app code for this episode.
- Webhook responses `add`, `replace` and `remove`: named in the post, not built.
