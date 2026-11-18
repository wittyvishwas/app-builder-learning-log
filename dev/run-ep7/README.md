# Ep 7 real-workspace run: scratch action and webhooks.xml variants

Module install steps are in `commerce/CartCheck/README.md`. Run helpers only; none of this is part of the `ep7-webhooks` tag. Run plan steps 1a and 1b. Check the namespace first (`aio rt property get --namespace`).

## Scratch action

`--web raw` matches how cart-check is deployed (`raw-http: true`): the body arrives as `__ow_body`, so the timings compare. The scratch action reads that body (JSON text or base64) and skips the signature check, so use test SKUs only.

```bash
aio rt action create cart-check-scratch dev/run-ep7/cart-check-scratch.js --web raw -p MODE normal -p RESTRICTED_SKUS MMTEST-RESTRICTED-1
aio rt action get cart-check-scratch --url          # the URL for CART_CHECK_SCRATCH_URL
```

Switch mode (`normal | sleep3s | invalid-json | http500`). `update` replaces the parameters, so pass both:

```bash
aio rt action update cart-check-scratch dev/run-ep7/cart-check-scratch.js --web raw -p MODE sleep3s -p RESTRICTED_SKUS MMTEST-RESTRICTED-1
```

Delete it after the run: `aio rt action delete cart-check-scratch`.

## Deploys

Copy the variant over the module file, set the env var the variant names, then push and redeploy (`webhooks.xml` is compiled at build):

```bash
cp dev/run-ep7/webhooks-A.xml commerce/CartCheck/etc/webhooks.xml
```

| Deploy | Variant | URL variable | required | softTimeout | Header |
|---|---|---|---|---|---|
| A | `webhooks-A.xml` | `CART_CHECK_SCRATCH_URL` | false | 1 | `x-ow-extra-logging: on` |
| B | `webhooks-B.xml` | `CART_CHECK_SCRATCH_URL` | true | 1 | `x-ow-extra-logging: on` |
| C (optional first push) | `webhooks-C-measure.xml` | `CART_CHECK_URL` | false | 1 | `x-ow-extra-logging: on` |
| C (final) | `webhooks-C.xml` | `CART_CHECK_URL` | false | 500 | none |

The rule field is `data.product.sku`: the rule checks the unfiltered dispatch data (`subject`, `eventName`, `data`) before `fields` are applied. So the `webhooks:dev:run` payload is:

```bash
bin/magento webhooks:dev:run observer.checkout_cart_product_add_before:before '{"data":{"product":{"sku":"MMTEST-RESTRICTED-1"}}}'
```

The `{env:...}` placeholders are read by PHP at runtime, so the variables must be visible to PHP. On Cloud they are project variables named `env:CART_CHECK_URL` and `env:CART_CHECK_SCRATCH_URL`.

Order: A (cycle the modes, then times) → B (cycle the modes) → C. Every variant only hooks SKUs matching `/^MMTEST-/`.
Last step of the run: copy `webhooks-C.xml` back, or remove the module (plan section 3).

## Timeouts and failures

A call that hits the hard `timeout="2000"` (`sleep3s`) writes no soft-timeout line. The evidence is the error `The request for hook "restricted_sku" failed` in `var/log/system.log`. `http500` and `invalid-json` are observations: record what you see.

## Recipes for plan steps 7 to 9 (untested)

Placeholders: `$STORE` (storefront base URL), `$SKU` (for example `MMTEST-OK-1`), `$CART_CHECK_URL`, `$PRODUCT_URL`, `$PRODUCT_ID`. None of these has been run yet; fix them as you go.

Luma add-to-cart (cookie jar, form key from the product page; the blocked reply is JSON with the message):

```bash
jar=/tmp/luma.jar
FORM_KEY=$(curl -s -c $jar -b $jar "$PRODUCT_URL" | grep -o 'name="form_key"[^>]*value="[^"]*"' | head -1 | sed 's/.*value="//;s/"$//')
curl -s -c $jar -b $jar -H 'X-Requested-With: XMLHttpRequest' \
  -d "form_key=$FORM_KEY&product=$PRODUCT_ID&qty=1" "$STORE/checkout/cart/add"
```

Headless check, REST guest cart (it probably bypasses the hook):

```bash
CART=$(curl -s -X POST "$STORE/rest/V1/guest-carts" | tr -d '"')
curl -s -X POST "$STORE/rest/V1/guest-carts/$CART/items" -H 'Content-Type: application/json' \
  -d "{\"cartItem\":{\"quote_id\":\"$CART\",\"sku\":\"$SKU\",\"qty\":1}}"
```

Headless check, GraphQL:

```bash
CART=$(curl -s -X POST "$STORE/graphql" -H 'Content-Type: application/json' -d '{"query":"mutation{createEmptyCart}"}' | sed 's/.*"createEmptyCart":"\([^"]*\)".*/\1/')
curl -s -X POST "$STORE/graphql" -H 'Content-Type: application/json' \
  -d "{\"query\":\"mutation{addProductsToCart(cartId:\\\"$CART\\\",cartItems:[{sku:\\\"$SKU\\\",quantity:1}]){user_errors{message}}}\"}"
```

Unsigned call straight to the real action (expect `{"op":"exception"}` with no message); change one byte of a signed body the same way for the tampered case:

```bash
curl -s -X POST "$CART_CHECK_URL" -H 'Content-Type: application/json' -d '{"product":{"sku":"MMTEST-OK-1"}}'
```

Timing loop, 20 add-to-cart calls (then read the soft-timeout lines in `var/log/system.log` on every node):

```bash
for i in $(seq 20); do
  curl -s -o /dev/null -w '%{time_total}\n' -c $jar -b $jar -H 'X-Requested-With: XMLHttpRequest' \
    -d "form_key=$FORM_KEY&product=$PRODUCT_ID&qty=1" "$STORE/checkout/cart/add"; sleep 1
done
```
