# App Builder learning log

Code for **Learn App Builder with me** on [MageMinion](https://mageminion.com/series/app-builder/): a Magento developer learning Adobe Developer App Builder from zero, in public, with Claude Code.

The series has two parts. Four foundation episodes, then a developer log written from real sessions. Every episode and every developer-log session gets a git tag, so you can check out exactly where the series was:

```bash
git checkout ep3-cron-state-files
```

| Tag | Episode | What's in it |
|---|---|---|
| `ep1-project-anatomy` | [Ep 1: the anatomy of a project](https://mageminion.com/app-builder-ep1-project-anatomy/) | The project layout, `app.config.yaml` (web action, inputs from `.env`, `require-adobe-auth`, `final`, limits), `.env.dist`, the `export-order` skeleton. `package.json` and `.env.dist` already list what Ep 3 needs; ignore those lines for Ep 1 |
| — | [Ep 2: start from a boilerplate](https://mageminion.com/app-builder-ep2-first-action/) | Ep 2 starts a real integration from Adobe's [commerce-integration-starter-kit](https://github.com/adobe/commerce-integration-starter-kit). Clone that kit; it isn't copied here |
| `ep3-cron-state-files` | [Ep 3: cron, config and custom tables](https://mageminion.com/app-builder-ep3-cron-state-files/) | `stuck-orders`: an alarm trigger and rule every 15 minutes, a Commerce REST query for orders stuck in `pending_payment`, one alert per order (State with a 7-day TTL), a State lock against overlapping runs, and an optional daily CSV report in Files (`SAVE_REPORT: true`) |
| `ep4-database-storage` | [Ep 4: Database Storage, when State isn't enough](https://mageminion.com/app-builder-ep4-database-storage/) | `sync-log`: an action that writes one row per export attempt to a collection and returns the latest failure for a SKU. The `database` block in `app.config.yaml` (auto-provisioned, region `emea`), `include-ims-credentials: true`, and a `post-app-deploy` hook that creates the indexes. `test/helpers.js` gains `fakeDb`, an in-memory aio-lib-db that later episodes reuse |
| `ep5-log-forwarding` | [Ep 5: forward your action logs to New Relic](https://mageminion.com/app-builder-ep5-log-forwarding-new-relic/) | No new code: log forwarding is workspace configuration. The README section below lists the commands |
| `ep6-commerce-events` | [Ep 6: replace an observer with a Commerce event](https://mageminion.com/app-builder-ep6-commerce-events/) | `events/order-placed`: handles `observer.sales_order_place_after` from I/O Events with only `order.increment_id` and `order.grand_total`, claims the order atomically in `order_claims` (unique index on `order`) before sending, so two deliveries of the same order can't both send, then sends it to the ERP (Idempotency-Key = order number), records the `sent` row, and answers 500 on failure so I/O Events retries. The tag `ep6-commerce-events` carries the claim version; the tags `ep7` to `ep10` keep the earlier handler (look, send, insert), which their posts don't show |
| `ep7-webhooks` | [Ep 7: replace a plugin with a webhook](https://mageminion.com/app-builder-ep7-webhooks/) | `webhooks/cart-check`: a web action with `raw-http: true` that verifies Commerce's `x-adobe-commerce-webhook-signature` over the base64 body, then answers `success`, or `exception` with a message for a SKU in `RESTRICTED_SKUS`; a missing or invalid signature is refused. Plus `commerce/webhooks.xml` |
| `ep8-api-mesh` | [Ep 8: API Mesh, one endpoint, and the truth about its cache](https://mageminion.com/app-builder-ep8-api-mesh/) | `mesh/mesh.json`: Commerce GraphQL and a REST reviews API behind one endpoint, joined with `keyField`/`keysArg`, mesh cache on. Endpoints are placeholders |
| `ep9-admin-ui-sdk` | [Ep 9: a page in the Commerce admin with the Admin UI SDK](https://mageminion.com/app-builder-ep9-admin-ui-sdk/) | An Admin UI SDK v1 extension (`src/commerce-backend-ui-1/`, laid out like Adobe's custom-menu sample): a **Stuck orders** menu item and a React Spectrum page listing open alerts, with `list-alerts` and `mark-handled` actions behind `require-adobe-auth`. `stuck-orders` now also writes each alert to the `stuck_alerts` collection |
| `ep10-port-a-module` | [Ep 10: port a small Magento module to App Builder](https://mageminion.com/app-builder-ep10-port-a-module/) | The order sync as the ported module: `order-sync/export-order` and the alarm-driven `export-order-retry` keep their bookkeeping in the `export_runs` collection (Ep 4), and State keeps only the retry lock. Both actions get `include-ims-credentials: true`. **Part A:** the store moved to Database Storage. **Part B:** a **Deliveries** tab on the Ep 9 admin page (`list-deliveries`, `retry-delivery`) that shows recent deliveries, failures first, with a Retry button |
| `main` | After Ep 10: order sync, admin page and fixes | The order sync (below) as of Ep 10, the Ep 9 admin page, and fixes to `stuck-orders` from a code review |
| `day-NN` | Developer log | One tag per session, with its write-up in [`log/`](log/) |

## Order sync to an ERP

In Ep 1, `export-order` was a web action behind Adobe auth that only checked its inputs. From Ep 10 on, Adobe I/O Events invokes it directly, so it is a non-web action with no public URL, and it does the work. The bookkeeping lives in Database Storage (`export_runs`, Ep 4); State keeps only a lock.

1. **Commerce** publishes `observer.sales_order_place_after` through Adobe I/O Events.
2. **`order-sync/export-order`** receives it, maps the order with `actions/order-sync/mapper.js` and POSTs it to `ERP_API_URL/orders` with a Bearer key and the order number as `Idempotency-Key`.
3. **Retries:** network errors, 429 and 5xx get up to three tries with backoff in the same call. If the ERP is still down, the order becomes a `retry` row in `export_runs` (with the mapped order, `attempts` and `nextAt`) and **`order-sync/export-order-retry`**, run by the alarm trigger every 10 minutes, resends it: one try per order per run, for up to six runs in total. A run picks `find({ status: 'retry', nextAt: { $lte: now } }).sort({ nextAt: 1 }).limit(MAX_PER_RUN)`, stops after 240 seconds as well, and reports what's `left` for the next run. A State lock (`order-sync.lock.retry`, `ifNotExists`, 10 minutes) stops a manual invoke from overlapping the scheduled run. It is the only thing order sync keeps in State.
4. **Duplicates:** a delivered order is a `sent` row, and the check is `findOne({ order, status: 'sent' })`. Ep 6's `events/order-placed` writes the same `sent` row (after its own claim), so `export-order` skips what `order-placed` sent; the other direction is not covered, because `order-placed` looks only at `order_claims`, so register only one of the two. Two deliveries that race (a redelivery while the first is still running) can both POST; the ERP's `Idempotency-Key` makes the second a 409, which counts as success. The ERP is the guarantee; the row is the fast path.
5. **One row per order.** Every write is `updateOne({ order }, { $set: ... }, { upsert: true })`, so an order normally moves `retry` -> `sent` or `dead` in place, as one row. Two writers racing (or Ep 6's sent-row upsert) can still leave two rows for an order, so the settle rule is: marking an order sent updates every row for it (`updateMany`) and sets `mapped` and `nextAt` to `null`, and a retry run that finds its order already sent settles the stray `retry` row the same way. `retry` and `dead` writes re-check for a `sent` row right before writing and never touch one; a tiny window remains between that check and the write, and a duplicate POST in it is covered by the ERP's `Idempotency-Key`. A retry row without a stored order is moved to `dead` (`cannot resend: no stored order`) and the run goes on; each row is processed on its own.
6. **Failures for a human:** a 4xx from the ERP, or an order still failing after the last run, becomes a `dead` row with the order number, `lines`, `totals`, `attempts`, `httpStatus` and `lastError`. The customer and addresses are left out (look them up in Commerce). ERP response bodies are never logged, at any level, because ERPs often echo the request, and error logs carry the message only, never the error object.
7. **Return codes:** the handler answers 200 for exported, skipped, queued, dead or malformed events, and an error only when it couldn't record anything (Database Storage down) or settings are missing, so I/O Events redelivers those. I haven't verified I/O Events' retry schedule for runtime-action consumers yet; check the [Events docs](https://developer.adobe.com/events/docs/) before relying on it.

**What moved from State to the database.** State had `done` (30 days), `retry` (7 days) and `dead` (365 days) keys with a time to live. Database Storage has **no TTL**: rows stay until someone deletes them. That is a feature for dead rows (a human reads them) and a chore for `sent` rows. Cleanup is not built here; a scheduled `deleteMany({ status: 'sent', at: { $lt: cutoff } })` (check that your aio-lib-db version supports it, and index `at`) is what to add once the collection grows. Until then the `retry` rows are the only ones that hold personal data (see below), and they are cleared when the order settles.

**Personal data.** `mapped` on a `retry` row is the complete ERP order, customer and addresses included, because a retry has to resend it as is. It exists for up to about an hour (six 10-minute runs), then becomes `null` when the row turns `sent` or `dead`. Dead rows never hold it.

**Credentials for alarm-triggered runs.** Database Storage needs the workspace's OAuth credentials, so both `export-order` and `export-order-retry` have `include-ims-credentials: true`. That annotation is what injects the credentials, and it applies to an alarm-triggered run as well as to a manual invoke. I can't verify that in CI (the tests fake the token call). After a deploy, check it once with `aio rt action invoke order-sync/export-order-retry --result` and, after the next alarm, with `aio rt activation list`; a missing credential shows up as a 500 with a token error in `aio rt activation logs`.

The ERP side is generic: change `mapper.js` for your ERP's order shape and `erp.js` if its API differs (URL, auth, duplicate status).

### Wire it up

This event nests the order under `order`, so every field is `order.<name>` (seen on commerce-eventing 1.23.0). A field that doesn't match arrives as an empty object, and Commerce still marks the event sent. Only `order.increment_id` and `order.grand_total` have been seen on a real instance. The other fields, the nested and array ones such as `order.items` and `order.shipping_address`, and `export-order` with the nested payload are unverified (the nested-payload fix is unit-tested only). Confirm with `bin/magento events:list` and one test order:

```bash
# Commerce: send the event, with exactly the fields mapper.js reads
bin/magento events:subscribe observer.sales_order_place_after \
  --fields=order.increment_id --fields=order.created_at --fields=order.order_currency_code --fields=order.base_currency_code \
  --fields=order.grand_total --fields=order.shipping_amount --fields=order.tax_amount \
  --fields=order.customer_email --fields=order.customer_firstname --fields=order.customer_lastname \
  --fields=order.billing_address --fields=order.shipping_address --fields=order.addresses \
  --fields=order.extension_attributes --fields=order.items
aio app deploy
```

That is the union of what `mapper.js` reads, all inside `order`, and the mapper takes the shipping address from the first of `extension_attributes.shipping_assignments[0].shipping.address`, `shipping_address` or the `shipping` entry of `addresses`. If your Commerce version sends the address in one of those places, you can subscribe to just that one. Ep 10's post uses a shorter command (`increment_id`, `items`, `shipping_address`, each needing the `order.` prefix); that is the fulfilment example, where the ERP only needs the lines and where to ship. This repo's mapper also sends the customer and totals, so it needs the fields above.

Then, in Developer Console, add an event registration in the workspace for `com.adobe.commerce.observer.sales_order_place_after` and pick the runtime action `order-sync/export-order` as its consumer.

### See what happened

```bash
aio app logs
aio rt activation list
aio rt action invoke order-sync/export-order-retry --result   # drain the retry queue now
```

## Database Storage

Ep 4 adds the document database for Runtime actions (`@adobe/aio-lib-db`) next to State and Files. Use State for a flag, lock or cursor with a time to live, Database Storage for records you query by field, and Files for large exports.

**Provision.** `app.config.yaml` has `database: { auto-provision: true, region: emea }` under `runtimeManifest`. It is provisioned by `aio app deploy`, not by `aio app run` or `aio app dev`. Each workspace has its own database, so Stage and Production are separate. The region can't be changed later without deleting the database, and `actions/sync-log` passes the same region to `init`. aio-lib-db itself takes the region from `app.config.yaml` when that file is in the working directory. By hand: `aio app db provision --region emea`.

**Auth.** The library needs an IMS token. Check three things, in order:

1. The **App Builder Data Services API** is added to the workspace in Developer Console.
2. A new access token was generated after adding it (the OAuth server-to-server credential).
3. The action has `include-ims-credentials: true`, as `order-sync/sync-log` does in `app.config.yaml`. The action then calls `Core.AuthClient.generateAccessToken(params)`.

**Indexes.** `hooks.post-app-deploy` runs `scripts/post-deploy-db-setup.js` after every deploy. It reads the workspace's OAuth credentials from `.env` (`IMS_OAUTH_S2S_CLIENT_ID`, `_CLIENT_SECRET`, `_ORG_ID`, `_SCOPES`) plus the namespace: `AIO_runtime_namespace`, which `aio app use` writes (it is also the deploy target), or the `AIO_RUNTIME_NAMESPACE` override (see `.env.dist`; `aio where` shows only the global Developer Console selection, so check the deploy namespace with `aio rt property get --namespace` run in the repo). The namespace is passed to `init` explicitly, because aio-lib-db otherwise reads `__OW_NAMESPACE`, which isn't set when aio runs a hook, gets a token, and creates the indexes below. Indexes that exist are skipped, so a second deploy changes nothing. `ensureIndexes(client)` is the pure part and is what the tests call. The hook is written as `node scripts/post-deploy-db-setup.js`, so it doesn't depend on the file's execute bit.

**Look inside without code:**

```bash
aio app db status
aio app db ping
aio app db collection list
aio app db index list export_runs
aio app db document find export_runs
aio app db document count export_runs
aio app db stats
```

**`sync-log` and the post.** The post reads the failure with `findOne({ sku, status: 'failed' })`. That returns a matching row, not necessarily the newest, so the repo sorts by `at` descending and takes one (`find(...).sort({ at: -1 }).limit(1)`), which is what the name `lastFailure` promises. The action also answers 400 when `sku` or `status` is missing, which the post's snippet omits: an `undefined` field is dropped from the stored row and from the query filter, so the lookup would return any SKU's latest failure. Everything else is as in the post.

Try it once deployed: `aio rt action invoke order-sync/sync-log -p sku MUG -p status failed -p error "ERP 503" --result`. That has not been run against a real workspace yet.

### Collections

Keep IDs, statuses and timestamps; look customer and order details up in Commerce instead of copying them in. Later episodes follow this table.

| Collection | Written by | Fields | Indexes |
|---|---|---|---|
| `export_runs` | Ep 4: `sync-log` | `sku`, `status`, `error` (or `null`), `at` (ISO time) | `{ sku: 1, at: -1 }`, `{ order: 1, status: 1 }`, `{ status: 1, nextAt: 1 }` |
| `export_runs` | Ep 6 (after its claim) and Ep 10: order rows | `order`, `status` (`sent`, `retry` or `dead`), `at`; on Ep 10 `retry` and `dead` rows also `attempts`, `lastError`, `httpStatus`; `retry` rows `nextAt` and `mapped` (the ERP order, which a retry resends as is, so it includes the customer and addresses until the row settles; then `null`); `dead` rows `lines` and `totals` only (no customer or addresses). Ep 10 checks `findOne({ order, status: 'sent' })` | same collection, same indexes |
| `order_claims` | Ep 6: `events/order-placed` | `order`, `status` (`sending`, `sent` or `failed`), `at` (ISO time, always `toISOString()`: the stale check compares it as a string) | unique `{ order: 1 }` |
| `stuck_alerts` | Ep 9: `stuck-orders` writes, `mark-handled` updates | `order`, `status`, `created_at` (the order's own creation time), `at` (last alert, ISO time), `handled` (boolean), `handledAt` (optional) | unique `{ order: 1 }`, `{ handled: 1, at: -1 }` |

Ep 6 claims each order in `order_claims` and writes the `sent` order rows (`events/order-placed`); Ep 10's `order-sync` actions write all three (`sent`, `retry`, `dead`), one row per order, with `updateOne` and upsert by `order`. The indexes for them are created by the hook. There is no TTL: rows stay until cleaned (see Order sync above).

## Commerce events (Ep 6)

`events/order-placed` is the handler from the post: Adobe I/O Events delivers `observer.sales_order_place_after`, and the action sends the order to the ERP once. It reads `params.data?.value ?? params.data`, then unwraps `order` when present (the order is nested under `order` on commerce-eventing 1.23.0), answers 400 (logging only the keys, never values) when there's no `increment_id`, claims the order, sends it with `sendToErp` (the post leaves that out; here it is in `actions/order-placed/index.js` and reuses `actions/order-sync/erp.js`, so the order number is the `Idempotency-Key` and a 409 counts as success), then upserts the `sent` row (`updateOne({ order, status: 'sent' }, { $set: { at } }, { upsert: true })`, so a repeat never adds a second one and a retry or dead row is left alone) and marks the claim `sent`. The claim is one `updateOne` with `upsert` on `order_claims`: it matches a claim that is `failed` or `sending` for more than 10 minutes, or inserts a new one, and the unique index on `order` rejects the insert when a `sent` or fresh `sending` claim exists. On any error from that call the action reads the claim: `sent` answers 200 `{ skipped: true }`, a fresh `sending` (another delivery is mid-send) answers 503 so I/O Events retries (it retries 429 and 5xx except 505 for up to 24 hours, and never a 409), and anything else answers 500. A failed send marks the claim `failed` so a redelivery can claim it again; if the process dies mid-send, the claim is claimable again after 10 minutes. If the `sent` row or the `sent` mark fails after a successful send, the next delivery sends again after that window and the ERP's `Idempotency-Key` makes it a 409. The order number must match `/^\S{1,64}$/`, else 400. Any error answers 500 so a retry is possible, and an event it can never process (no order number) answers 400, as in the post. On Stage, the I/O Events delivery trace showed the action's returned 400 and 200 as the delivery's response status. Whether a returned 503 or 500 starts an I/O Events retry is still unverified. A permanent ERP error (400/422) also returns 500 here, so each redelivery POSTs again; Ep 10's `export-order` writes a `dead` row for those instead. `export-order` answers 200 for malformed events while `order-placed` follows the post's 400, because an unprocessable event shouldn't count as a delivery failure against the registration. `sendToErp` stays in `index.js` because it is one small helper; the post's tip about its own file applies once it grows. The database client is closed in `finally`. The claim isn't on `export_runs` because Ep 4 rows have no `order` field, and a unique index treats all missing values as equal. **Verify on Stage:** the exact error text of a unique-index violation on Adobe's service (message and code) has not been captured; the action decides from the claim document, and the error only picks the log level, but run one real duplicate upsert and record what comes back. Also check on Stage that one upsert with the claim's `$or` filter creates a document with exactly `{ order, status, at }` (the fake copies equality fields from the filter, as MongoDB does; a multi-clause `$or` adds nothing), that two concurrent claims for one order give exactly one duplicate-key error, and that a Runtime action's returned 503 or 500 starts an I/O Events retry the way the docs describe for a webhook response (unverified).

```bash
# Commerce (PaaS): the event provider, then the subscription with only the fields the handler needs
bin/magento events:create-event-provider --label "Shop Stage" --description "Commerce events from Stage"
bin/magento events:subscribe observer.sales_order_place_after \
  --fields=order.increment_id --fields=order.grand_total --priority
bin/magento events:list
aio app deploy
```

The handler accepts the nested shape (`{ order: { increment_id, grand_total } }`) and still reads the flat one.

Then, in Developer Console, in the workspace: **Add service > Event > Commerce events**, pick the provider, tick `observer.sales_order_place_after`, and choose the runtime action `events/order-placed` as the consumer.

**Duplicates.** Commerce retries sending events to Adobe I/O, up to 7 times by default, so the same order can arrive more than once; the `export_runs` check is what makes that safe. Two deliveries that race can both pass the check and both POST; the ERP's `Idempotency-Key` makes the second a 409, which counts as success, so the ERP stays the guarantee.

**Register only one.** `events/order-placed` and `order-sync/export-order` both consume the same event. `order-sync/export-order` is the full version, built in Ep 10 (retry rows, dead rows, mapped order), and `order-placed` is the minimal one this episode teaches. Register one of them as the consumer, never both, or every order is handled twice. Not verified on a real workspace yet.

## Log forwarding to New Relic (Ep 5)

Forwarding is set per workspace. Run this once for Stage and once for Production, each after `aio app use`:

```bash
aio app config set log-forwarding
? select log forwarding destination: New Relic
? base URI: https://log-api.eu.newrelic.com/log/v1
? license key: <your INGEST - LICENSE key>
```

The base URI depends on where you log in to New Relic. US (`https://one.newrelic.com/`): `https://log-api.newrelic.com/log/v1`. EU (`https://one.eu.newrelic.com/`): `https://log-api.eu.newrelic.com/log/v1`. Include the `https://`. A wrong region doesn't fail loudly; your logs just never arrive.

The license key is stored in `.env`, which stays out of git. The setting applies to the workspace as soon as `aio app config set log-forwarding` runs, not on the next deploy. Deploy the actions as usual, then check it; `get` shows the destination and base URI, never the key:

```bash
aio app deploy
aio app config get log-forwarding
```

A later deploy re-applies the settings stored in `.aio` and `.env`, unless it runs with `--no-actions` or `--no-log-forwarding-update`.

Run an action that logs, then open **Logs** in New Relic and look for the new lines:

```bash
aio rt action invoke ops/stuck-orders --result
```

Keep `LOG_LEVEL: info` in the action inputs (already set in `app.config.yaml`), and use `debug` only while you investigate. Forwarding sends what you write, and an action's logs are cut off after 10 MB per activation.

If nothing arrives, run `aio app config get log-forwarding errors`. It shows the most recent 10 forwarding errors, from up to 30 days back. The usual causes are the wrong regional base URI, a key that isn't an ingest license key, or a later deploy run with `--no-log-forwarding-update` over a changed setting.

Once logs leave the terminal, more people read them. Log one line per significant step, with the order number or SKU in it. Never log tokens, API keys or customer personal data. Log errors with the reason and the next action ("will retry in 15 minutes"), not just a stack trace.

## Webhooks (Ep 7)

A Commerce webhook asks your app before Commerce acts, like an out-of-process `before` plugin. `webhooks/cart-check` answers for `observer.checkout_cart_product_add_before`: `{ "op": "success" }` lets the item in, `{ "op": "exception", "message": "..." }` stops it.

`commerce/webhooks.xml` declares the hook. On PaaS it goes in a small module's `etc/` (set `CART_CHECK_URL` to the deployed action's URL), then:

```bash
bin/magento setup:upgrade
bin/magento webhooks:list
bin/magento webhooks:info observer.checkout_cart_product_add_before --webhook-type=before
bin/magento webhooks:dev:run observer.checkout_cart_product_add_before:before '{"data":{"product":{"sku":"RESTRICTED-1"}}}'
```

`webhooks:info` prints the payload Commerce sends, so you pick the `source` paths from it; `webhooks:dev:run` calls your hook with a payload you supply. In production mode run `bin/magento cache:clean config` after a change. On Adobe Commerce as a Cloud Service there is no module: enter the same settings in the admin under **System > Webhooks**.

**Fail open or closed.** The example uses `required="false"`: if the endpoint times out or errors, Commerce logs it and carries on (fail open). `required="true"` logs it and throws (fail closed). Use open for nice-to-have checks and closed, with a short `timeout` and monitoring, for legal or financial rules. A restricted-goods rule like this one arguably belongs in the closed group; the example stays open so a slow action can't block your store while you learn. `required` only governs timeouts and errors, not our own `{ "op": "exception" }`, which always blocks. So the action separates two cases. A forged call, or a signature that doesn't match, answers 200 with `exception` and is blocked. A missing or unusable `PUBLIC_KEY` is our misconfiguration, so it answers **500** and logs `PUBLIC_KEY missing or invalid`: with `required="false"` Commerce then fails open instead of blocking every add-to-cart. Note that rotating the key pair in Commerce without updating `.env` and redeploying leaves the old key in place: every genuine call then fails the signature check and add-to-cart is blocked.

**Signature.** The action URL is public. In **Stores > Settings > Configuration > Adobe Services > Webhooks** enable digital signatures and click **Regenerate key pair**, then put the public key in `.env` as `PUBLIC_KEY`. Commerce signs each request and sends the base64 signature in `x-adobe-commerce-webhook-signature`. With `raw-http: true`, `__ow_body` arrives base64-encoded, and the action verifies the signature over that base64 string as received, then decodes and parses it. That follows Adobe's App Builder sample (`verifier.update(params.__ow_body)`, then `JSON.parse(atob(params.__ow_body))`). Adobe's Express sample instead verifies over `Buffer.from(JSON.stringify(body)).toString('base64')`; if the body arrives as JSON text, the action does the same. The payload follows the hook's field `name`, so `name="product.sku"` arrives as `{ "product": { "sku": "..." } }` and the action reads `product.sku`. **Not verified yet** with `webhooks:dev:run` or on Stage. A missing or invalid signature, or a signed payload without a SKU, answers `{ "op": "exception" }`. Regenerating the key pair invalidates the old key at once: update `.env` and redeploy together.

A PEM has line breaks, and `.env` is one line per variable. Write the key on one line with `\n` for each break; the action turns `\n` back into newlines:

```text
PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEF...\n-----END PUBLIC KEY-----
RESTRICTED_SKUS=RESTRICTED-1,RESTRICTED-2
```

Not verified against a real Commerce yet: the tests sign bodies with their own key pair.

## API Mesh (Ep 8)

`mesh/mesh.json` puts Commerce GraphQL and a REST reviews API behind one endpoint. A mesh belongs to one workspace, so select yours first with `aio console workspace select`. Replace the `example.com` endpoints, then:

```bash
aio plugins:install @adobe/aio-cli-plugin-api-mesh
aio api-mesh:create mesh/mesh.json
aio api-mesh:status
aio api-mesh:describe
```

The `responseSchema` path is relative to `mesh.json`, so `reviews-schema.json` must stay next to it. The REST handler is spelled `JsonSchema`; `jsonSchema` is rejected. Only `SimpleProduct` gets `reviews` here; repeat the type extension and resolver for `ConfigurableProduct` and other product types you sell.

The reviews endpoint must answer `/reviews?skus=A,B` with one list per SKU, in the order asked (an array of arrays); that's how the batched join maps results back to products. How the array is written into the query string is not verified on a real mesh yet.

- **Off by default.** `"cache": true` in `responseConfig` turns it on. If you bring your own CDN, set `"cache": false` so responses aren't cached twice.
- **The response is the unit.** Query-level caching isn't supported. A response gets one set of `Cache-Control` headers and is cached as a whole.
- **Sources vote, the lowest wins.** Conflicting `max-age`, `s-maxage`, `stale-while-revalidate`, `stale-if-error` and similar resolve to the lowest value.
- **`no-store` beats everything.** If any source says `no-store`, the whole response is `no-store`.
- **Mesh config can't override a source.** A default `Cache-Control` in the mesh config only applies to sources that send none. Change the source to change its lifetime.
- **GET requests are limited to 2,048 characters.** A CDN of your own usually caches GET only.
- **Purge after a mesh change:** `aio api-mesh:cache:purge -a`, or your CDN's purge.

## Admin UI SDK (Ep 9)

`src/commerce-backend-ui-1/` is an Admin UI SDK **v1** extension (`extensions: commerce/backend-ui/1` in `app.config.yaml`). Its layout and registration fields are copied from Adobe's [custom-menu sample](https://github.com/adobe/adobe-commerce-samples/tree/main/admin-ui-sdk/v1/menu/custom-menu): a `registration` web action returns `menuItems` (`id`, `title`, `parent`, `sortOrder`, plus the sample's `Apps` section with `isSection: true`) and `page.title`; `web-src/` is the sample's bootstrap (`exc-runtime`, `register`, `attach` for the IMS token, `callAction`) with React Spectrum tables. The menu item is **Stuck orders** under the sample's **Apps** section; no new section.

- `list-alerts`: `find({ handled: { $ne: true } }).sort({ at: -1 }).limit(50)` on `stuck_alerts`, as in the post.
- `mark-handled`: needs `order` (400 without it, 404 for an unknown order), then `updateOne` setting `handled: true` and `handledAt`.
- `list-deliveries` (Ep 10): the recent `export_runs` rows that have an `order` field (Ep 4's sync-log rows share the collection and are left out), failures first (`dead`, then `retry`, then `sent`), newest first within each, at most 50. It returns `order`, `status`, `attempts`, `lastError`, `httpStatus`, `at` and `nextAt` only: never `mapped`, which holds the customer and addresses.
- `retry-delivery` (Ep 10): needs `order` (400 without it). A `retry` row gets `nextAt` = now, so the next retry run resends the stored order. A `dead` row keeps no order (no personal data), so Retry fetches it again from Commerce (`GET {COMMERCE_BASE_URL}/rest/V1/orders` filtered by `increment_id`, bearer `COMMERCE_TOKEN`, the inputs of `ops/stuck-orders`), maps it with `actions/order-sync/mapper.js` (which already reads the REST shape, including the shipping address under `extension_attributes.shipping_assignments`, so no adapter), and writes the row back as `retry` with `attempts` 0, `nextAt` now and the fresh `mapped` order. Answers: 404 for no such row or an order Commerce doesn't have, 502 `commerce error` when Commerce fails, 409 for a `sent` row (or a row that became `sent` while Commerce was asked: the update filters on `status: 'dead'`, so a sent row is never touched).
- The page has two tabs, **Stuck orders** and **Deliveries**; the table shows order, status, attempts, last error and time, with a **Retry** button on `dead` rows (a `retry` row is already due at the next run; the action still accepts one and makes it due now). A `retry` or `dead` row of an order that also has a `sent` row is left out of the list. The Commerce call times out after 10 seconds (502).
- `stuck-orders` (main only; the tags `ep1` and `ep3` don't move) upserts a `stuck_alerts` row per alerted order after the alert went out and was remembered. `handled` and `created_at` are set on insert only, so a re-alert (State's 7-day TTL expired, order still stuck) refreshes `status` and `at` but doesn't reopen a handled row. A database failure is logged by message and never blocks or repeats the alert, like the Files report. It needs `include-ims-credentials: true`, now set in `app.config.yaml`.

**Enable it in the admin.** Stores > Settings > Configuration > Adobe Services > Admin UI SDK: set **Enable Admin UI SDK** to Yes, select the app under **Configure eligible extensions**, and after every `aio app deploy` click **Refresh selected extensions**. **Database logging** writes the SDK's logs to System > Admin UI SDK > Admin UI SDK Logs.

**Local testing.** `aio app dev` with **Enable local testing** and **Local Server Base URL** in the same section works on PaaS and with v1 only; on Commerce as a Cloud Service local testing must stay off. `web-src/src/config.json` (action URLs) is generated by `aio app build` and `aio app dev` and is git-ignored.

**"Admin-only" means `require-adobe-auth: true`.** Both data actions are web actions that accept only a valid Adobe token for the org, and the page sends the signed-in admin's token. v1 has no per-action ACL: any user of the org with a token can call them, so don't put anything beyond "list and acknowledge alerts" behind them. ACL-protected menu items and actions are a v2 feature.

**Version 2.** `commerce/backend-ui/2` declares menus (and grid columns, mass actions, order-view buttons) in an `adminUi` block of the app's Commerce configuration instead of a registration action. This repo uses v1 because that's what Adobe's samples show; the two aren't compatible, so pick one per app. Not built here.

**What's verified.** The registration shape, `list-alerts`, `mark-handled`, `list-deliveries`, `retry-delivery` (including the next retry run picking the re-queued row up) and the `stuck_alerts` writes are unit-tested with the database faked. The React page is **not** covered by `npm test` or CI (it needs the aio CLI, a bundler and a Commerce admin); it has to be checked with `aio app dev`, and has not been. Its dependencies (React, React Spectrum, UIX, exc-app) are `devDependencies` only: the actions don't need them. The page needs them to build, so run `aio app build` or `aio app dev` after a full `npm install`, not `--omit=dev`.

## Test helper: fake ERP

`actions/fake-erp` (action `dev/fake-erp`) is a small fake ERP, so a real-workspace run has something to send orders to. It is a test helper, not part of the order-sync design. `POST /orders` stores the order in State for seven days (`201`, or `409` if it already has that order number); `GET /orders?order=<n>` reads it back (`200` or `404`). Every request needs `Authorization: Bearer <FAKE_ERP_API_KEY>`; an unset, empty or shorter-than-16-character key refuses everything with `401`. An order number outside `[A-Za-z0-9_.-]{1,64}` gets `400`.

Orders it receives (they may include customer data) stay in State for 7 days, so use it in test workspaces only. A State failure answers `503` (erp.js retries it); a stored order over 64 KB answers `413`.

It is a public web action and deploys with every `aio app deploy`, including a Production workspace. Remove the `dev` package from `app.config.yaml` (or `aio app undeploy`) when you don't need it.

To use it, set `FAKE_ERP_API_KEY` and `ERP_API_KEY` to the same value in `.env` and point `ERP_API_URL` at the action: `https://<namespace>.adobeioruntime.net/api/v1/web/dev/fake-erp`.

## What's verified

Each piece is marked by how far it has been proven:

- **Unit-tested:** `npm test` (217 tests, run in CI on Node 20 and 24) runs the actions with Commerce, the ERP, the alert webhook, State, Files and Database Storage faked. The database fake (`fakeDb` in `test/helpers.js`) supports equality, `$or`/`$and`, `$ne`, `$in`, `$lt`/`$lte`/`$gt`/`$gte`, `find().sort().limit().toArray()`, `updateOne` with `$set` and upsert, unique indexes, and throws `DbError`; it proves our logic, not the real service. The State fake behaves like aio-lib-state 5.4 where it matters: `ifNotExists` (the retry lock). That proves the mapping, retries, skipping a redelivered event, the retry rows, the lock, time budget, dead rows without personal data, one row per order across sent, retry and dead, no ERP body or error object in any log line, the stuck-order query, alert-then-remember, the report, and the webhook's signature check (real RSA keys, a tampered body, a base64 body, an escaped-newline PEM, a missing key answering 500). It doesn't prove a deployment. The fake ERP test helper is unit-tested the same way (State faked).
- **Verified on a real Stage workspace** (one run, Adobe Commerce on cloud infrastructure with commerce-eventing 1.23.0):
  - `aio app deploy --no-publish -e application` built and deployed the seven application actions on `nodejs:20`.
  - Database Storage was provisioned in `emea`. The post-deploy hook created the six indexes with the real OAuth credential (scopes as the JSON array `aio app use` writes).
  - `dev/fake-erp` answered 201, 409, 401, 400 and GET 200. Runtime refused a request body carrying `FAKE_ERP_API_KEY` with 400 (`final: true`).
  - A subscription to `observer.sales_order_place_after` with flat field names (`increment_id`, `grand_total`) delivered `data.value` as an empty object. Commerce still marked the event sent, and the handler answered 400.
  - With `order.increment_id` and `order.grand_total`, one real order was delivered by I/O Events to `events/order-placed`. It answered 200, sent the order to the fake ERP once, and wrote one `sent` claim and one `sent` row.
  - The I/O Events delivery trace showed the action's returned 400 and 200 as the delivery's response status.
  - Invoking the action again by hand with the same payload answered `{ skipped: true }` with no second send. That was a manual invoke, not an I/O Events redelivery.
- **Still unverified:**
  - I/O Events redelivery and retry on 500 or 503.
  - Concurrent claims, the duplicate-key error text and the exact claim document shape.
  - `order-sync/export-order` (never registered; its nested-payload fix is unit-tested only), `export-order-retry`, `sync-log` invocation and `stuck-orders`.
  - `cart-check`, API Mesh, the Admin UI extension and its build, and log forwarding.
  - Nested and array `--fields` such as `order.items` and `order.shipping_address`.
- **Not built yet:** `retry-delivery` imports `actions/order-sync/mapper.js` from outside the extension folder. The aio bundler should include it, but the Admin UI extension has not been built yet.

## Run it

```bash
npm install
npm test
cp .env.dist .env        # fill in; never commit .env or .aio
aio app use <your-workspace>.json
aio rt property get --namespace   # check the deploy namespace before every deploy (run in the repo; or AIO_runtime_namespace in .env). aio where shows only the global selection.
aio app deploy
aio rt action invoke ops/stuck-orders --result   # run the Ep 3 job once by hand
```

Ep 3 needs a Commerce integration token with read access to Sales > Operations > Orders and an incoming-webhook URL for the alert. On PaaS, also allow OAuth access tokens as standalone bearer tokens; on Adobe Commerce as a Cloud Service (ACCS), the SaaS edition, that setting doesn't exist and the bearer must be an IMS token. `.env.dist` lists every variable.

## Layout

```text
actions/
  utils.js                      # input check and error response helpers
  export-order/index.js         # order sync: I/O Events handler (Ep 1 skeleton at tag ep1-project-anatomy)
  export-order-retry/index.js   # order sync: scheduled retry
  order-sync/                   # mapper, ERP client, export_runs bookkeeping (Database Storage) and the State lock, export logic
  stuck-orders/index.js         # Ep 3
  sync-log/index.js             # Ep 4: Database Storage
  order-placed/index.js         # Ep 6: Commerce event handler, claims each order in order_claims
  cart-check/index.js           # Ep 7: webhook that verifies Commerce's signature and blocks restricted SKUs
  fake-erp/index.js             # test helper: fake ERP web action (dev/fake-erp)
src/commerce-backend-ui-1/      # Ep 9: Admin UI SDK v1 extension (ext.config.yaml, actions/registration|list-alerts|mark-handled|list-deliveries|retry-delivery, web-src/)
commerce/
  webhooks.xml                  # Ep 7: webhook declaration (PaaS module etc/; SaaS: System > Webhooks)
mesh/                           # Ep 8: mesh config and the reviews response schema
scripts/
  post-deploy-db-setup.js       # Ep 4: post-app-deploy hook, creates the indexes
app.config.yaml                 # actions, two alarm triggers and their rules, database, post-deploy hook
test/                           # Jest unit tests (everything external faked)
log/                            # developer-log write-ups, one per tag
```

Licence: Apache-2.0 (`LICENSE`, `NOTICE`).
