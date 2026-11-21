# App Builder learning log

Code for **Learn App Builder with me** on [MageMinion](https://mageminion.com/series/app-builder/): a Magento developer learning Adobe Developer App Builder from zero, in public, with Claude Code.

The series has two parts. Four foundation episodes, then a developer log written from real sessions. Every episode and every developer-log session gets a git tag, so you can check out exactly where the series was:

```bash
git checkout ep3-cron-state-files
```

| Tag | Episode | What's in it |
|---|---|---|
| `ep1-project-anatomy` | [Ep 1: the anatomy of a project](https://mageminion.com/app-builder-ep1-project-anatomy/) | The project layout, `app.config.yaml` (web action, inputs from `.env`, `require-adobe-auth`, `final`, limits), `.env.dist`, the `export-order` skeleton. `package.json` and `.env.dist` already list what Ep 3 needs; ignore those lines for Ep 1 |
| — | [Ep 2: start from a boilerplate](https://mageminion.com/app-builder-ep2-integration-starter-kit/) | Ep 2 starts a real integration from Adobe's [commerce-integration-starter-kit](https://github.com/adobe/commerce-integration-starter-kit). Clone that kit; it isn't copied here |
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

The tag `ep8-api-mesh` still has `reviews` in `mesh/mesh.json`. Against Commerce the mesh build fails (`Field "SimpleProduct.reviews" already exists in the schema`). `main` has the fix: the field is `externalReviews`.

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

**Credentials for alarm-triggered runs.** Database Storage needs the workspace's OAuth credentials, so both `export-order` and `export-order-retry` have `include-ims-credentials: true`. That annotation is what injects the credentials, and it applies to an alarm-triggered run as well as to a manual invoke. I can't verify that in CI (the tests fake the token call). After a deploy, check it once with `aio rt action invoke order-sync/export-order-retry --result` and, after the next alarm, with `aio rt activation list`; a missing credential shows up as a 500 with a token error in `aio rt activation logs`. On Stage the alarm-triggered run succeeded (Ep 10 run).

The ERP side is generic: change `mapper.js` for your ERP's order shape and `erp.js` if its API differs (URL, auth, duplicate status).

### Wire it up

This event nests the order under `order`, so every field is `order.<name>` (seen on commerce-eventing 1.23.0). A field that doesn't match arrives as an empty object, and Commerce still marks the event sent. `order.increment_id`, `order.grand_total`, `order.items` and `order.addresses` have been seen on a real instance. `order.shipping_address` arrives as null (the order data has no such key); `order.addresses` works, and the mapper's fallback picks the shipping address from it, so subscribe with `order.addresses`. The other fields are unverified. If a Commerce instance has two event providers, add `--providerId=<id>` to `events:subscribe`, or the event goes to the default provider and your registration never sees it. Confirm with `bin/magento events:list` and one test order:

```bash
# Commerce: send the event, with exactly the fields mapper.js reads
bin/magento events:subscribe observer.sales_order_place_after \
  --fields=order.increment_id --fields=order.created_at --fields=order.order_currency_code --fields=order.base_currency_code \
  --fields=order.grand_total --fields=order.shipping_amount --fields=order.tax_amount \
  --fields=order.customer_email --fields=order.customer_firstname --fields=order.customer_lastname \
  --fields=order.billing_address --fields=order.addresses \
  --fields=order.extension_attributes --fields=order.items
aio app deploy
```

That is the union of what `mapper.js` reads, all inside `order`, and the mapper takes the shipping address from the first of `extension_attributes.shipping_assignments[0].shipping.address`, `shipping_address` or the `shipping` entry of `addresses`. If your Commerce version sends the address in one of those places, you can subscribe to just that one. Ep 10's post uses a shorter command (`order.increment_id`, `order.items`, `order.addresses`); that is the fulfilment example, where the ERP only needs the lines and where to ship. This repo's mapper also sends the customer and totals, so it needs the fields above.

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

**Indexes.** `hooks.post-app-deploy` runs `scripts/post-deploy-db-setup.js` after every deploy. It reads the workspace's OAuth credentials from `.env` (`IMS_OAUTH_S2S_CLIENT_ID`, `_CLIENT_SECRET`, `_ORG_ID`, `_SCOPES`) plus the namespace. The hook reads `AIO_runtime_namespace`, which `aio app use` writes (it is also the deploy target). aio treats `AIO_RUNTIME_NAMESPACE` as the same setting, so don't set the two to different values (see `.env.dist`). `aio where` shows only the global Developer Console selection, so check the deploy namespace with `aio rt property get --namespace` run in the repo. The namespace is passed to `init` explicitly, because aio-lib-db otherwise reads `__OW_NAMESPACE`, which isn't set when aio runs a hook, gets a token, and creates the indexes below. Indexes that exist are skipped, so a second deploy changes nothing. `ensureIndexes(client)` is the pure part and is what the tests call. The hook is written as `node scripts/post-deploy-db-setup.js`, so it doesn't depend on the file's execute bit.

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

**`sync-log` and the post.** Both read the last failure with `find({ sku, status: 'failed' }).sort({ at: -1 }).limit(1)`, which is what the name `lastFailure` promises; a `findOne` would return a matching row, not necessarily the newest. On aio-lib-db 1.1.0 a `findOne` with no match also throws a `DbError` (`... failed: Document not found`) instead of returning null, so wrap it if you use it (see `findOneOrNull` in `actions/order-sync/store.js`). The action also answers 400 when `sku` or `status` is missing, which the post's snippet omits: an `undefined` field is dropped from the stored row and from the query filter, so the lookup would return any SKU's latest failure. Everything else is as in the post.

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

`events/order-placed` is the handler from the post: Adobe I/O Events delivers `observer.sales_order_place_after`, and the action sends the order to the ERP once. It reads `params.data?.value ?? params.data`, then unwraps `order` when present (the order is nested under `order` on commerce-eventing 1.23.0), answers 400 (logging only the keys, never values) when there's no `increment_id`, claims the order, sends it with `sendToErp` (the post leaves that out; here it is in `actions/order-placed/index.js` and reuses `actions/order-sync/erp.js`, so the order number is the `Idempotency-Key` and a 409 counts as success), then upserts the `sent` row (`updateOne({ order, status: 'sent' }, { $set: { at } }, { upsert: true })`, so a repeat never adds a second one and a retry or dead row is left alone) and marks the claim `sent`. The claim is one `updateOne` with `upsert` on `order_claims`: it matches a claim that is `failed` or `sending` for more than 10 minutes, or inserts a new one, and the unique index on `order` rejects the insert when a `sent` or fresh `sending` claim exists. On any error from that call the action reads the claim: `sent` answers 200 `{ skipped: true }`, a fresh `sending` (another delivery is mid-send) answers 503 so I/O Events retries (it retries 429 and 5xx except 505 for up to 24 hours, and never a 409), and anything else answers 500. A failed send marks the claim `failed` so a redelivery can claim it again; if the process dies mid-send, the claim is claimable again after 10 minutes. If the `sent` row or the `sent` mark fails after a successful send, the next delivery sends again after that window and the ERP's `Idempotency-Key` makes it a 409. The order number must match `/^\S{1,64}$/`, else 400. Any error answers 500 so a retry is possible, and an event it can never process (no order number) answers 400, as in the post. On Stage, the I/O Events delivery trace showed the action's returned 400 and 200 as the delivery's response status. On Stage, a scratch action's returned 503 was retried by I/O Events (three retries, 60, 120 and 240 seconds apart) and a returned 409 was not. A returned 500 from `order-sync/export-order` was redelivered too (Ep 10 run; the timing was not measured). A permanent ERP error (400/422) also returns 500 here, so each redelivery POSTs again; Ep 10's `export-order` writes a `dead` row for those instead. `export-order` answers 200 for malformed events while `order-placed` follows the post's 400, because an unprocessable event shouldn't count as a delivery failure against the registration. `sendToErp` stays in `index.js` because it is one small helper; the post's tip about its own file applies once it grows. The database client is closed in `finally`. The claim isn't on `export_runs` because Ep 4 rows have no `order` field, and a unique index treats all missing values as equal. **Verify on Stage:** the exact error text of a unique-index violation on Adobe's service (message and code) has not been captured; the action decides from the claim document, and the error only picks the log level, but run one real duplicate upsert and record what comes back. Seen on Stage: two concurrent manual invokes for one order gave one 200 and one 503 and left one claim document with exactly `{ order, status, at }` (plus `_id`). Still to check: that the losing claim's error is one duplicate-key error (it was not captured; event-started and scratch logs weren't visible from the CLI).

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

**Register only one.** `events/order-placed` and `order-sync/export-order` both consume the same event. `order-sync/export-order` is the full version, built in Ep 10 (retry rows, dead rows, mapped order), and `order-placed` is the minimal one this episode teaches. Register one of them as the consumer, never both, or every order is handled twice. On Stage, `order-sync/export-order` ran as the only consumer (Ep 10 run). Registering both at once was not tried.

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

A later deploy re-applies the settings stored in `.aio` and `.env`, unless it runs with `--no-actions` or `--no-log-forwarding-update`. `set` stores the key as `NEW_RELIC__LICENSE_KEY` in `.env`. To switch back, run `aio app config set log-forwarding` again and choose **Adobe I/O Runtime**, then delete the `NEW_RELIC__LICENSE_KEY` line from `.env` yourself.

Run an action that logs, then open **Logs** in New Relic and look for the new lines (on Stage they could be found within about 10 to 12 seconds; the full line is in `log_message`, there's no `message` or `level` attribute):

```bash
aio rt action invoke ops/stuck-orders --result
```

Keep `LOG_LEVEL: info` in the action inputs (already set in `app.config.yaml`), and use `debug` only while you investigate. Forwarding sends what you write, and an action's logs are cut off after 10 MB per activation.

If nothing arrives, run `aio app config get log-forwarding errors`. It shows the most recent 10 forwarding errors, from up to 30 days back. The usual causes are the wrong regional base URI, a key that isn't an ingest license key, or a later deploy run with `--no-log-forwarding-update` over a changed setting.

Once logs leave the terminal, more people read them. Log one line per significant step, with the order number or SKU in it. Never log tokens, API keys or customer personal data. Log errors with the reason and the next action ("will retry in 15 minutes"), not just a stack trace.

## Webhooks (Ep 7)

A Commerce webhook asks your app before Commerce acts, like an out-of-process `before` plugin. `webhooks/cart-check` answers for `observer.sales_quote_add_item`: `{ "op": "success" }` lets the item in, `{ "op": "exception", "message": "..." }` stops it. It blocks only SKUs listed in `RESTRICTED_SKUS` (comma-separated, in `.env`); with it unset everything is allowed.

**Which hook.** `observer.sales_quote_add_item` is dispatched in `Quote::addItem()`, which every channel uses, so one hook should cover the storefront, GraphQL `addProductsToCart` and REST `POST /V1/guest-carts/{id}/items`. GraphQL and REST were verified blocked on Stage; the storefront follows from the source and was not run with this hook. `observer.checkout_cart_product_add_before` is dispatched only in `Magento\Checkout\Model\Cart::addProduct()` (the storefront `checkout/cart/add` controller), so GraphQL and REST skip it. Verified on Adobe Commerce 2.4.8-p5: with only that hook, a restricted SKU was added through GraphQL and REST with no activation. GraphQL returns the block as `user_errors` with code `UNDEFINED` and the message; REST returns HTTP 400 with the message.

`commerce/webhooks.xml` declares the hook. On PaaS it goes in a small module's `etc/` (set `CART_CHECK_URL` to the deployed action's URL). `commerce/CartCheck/` is that module, ready to copy (see its README); its hook has a rule, so it fires only for `MMTEST-` SKUs. Then:

```bash
bin/magento setup:upgrade
bin/magento webhooks:list
bin/magento webhooks:info observer.sales_quote_add_item --depth=4
bin/magento webhooks:dev:run observer.sales_quote_add_item:before '{"data":{"quote_item":{"sku":"RESTRICTED-1"}}}'
```

`webhooks:info` prints the payload Commerce sends, so you pick the `source` paths from it; `webhooks:dev:run` calls your hook with a payload you supply. The method needs its type suffix (`:before`); without it the CLI says the webhook is not registered. `dev:run` applies the hook's rules and prints "The webhook was successfully processed." also when a rule skips the call, so check the activation list to tell a call from a skip. In production mode run `bin/magento cache:clean config` after a change. On Adobe Commerce as a Cloud Service there is no module: enter the same settings in the admin under **System > Webhooks**.

**Fail open or closed.** The example uses `required="false"`: if the endpoint times out or errors, Commerce logs it and carries on (fail open). `required="true"` logs it and throws (fail closed). Use open for nice-to-have checks and closed, with a short `timeout` and monitoring, for legal or financial rules. A restricted-goods rule like this one arguably belongs in the closed group; the example stays open so a slow action can't block your store while you learn. `required` only governs timeouts and errors, not our own `{ "op": "exception" }`, which always blocks. So the action separates two cases. A forged call, or a signature that doesn't match, answers 200 with `exception` and is blocked. A missing or unusable `PUBLIC_KEY` is our misconfiguration, so it answers **500** and logs `PUBLIC_KEY missing or invalid`: with `required="false"` Commerce then fails open instead of blocking every add-to-cart. Note that rotating the key pair in Commerce without updating `.env` and redeploying leaves the old key in place: every genuine call then fails the signature check and add-to-cart is blocked.

**Signature.** The action URL is public. In **Stores > Settings > Configuration > Adobe Services > Webhooks** enable digital signatures and click **Regenerate key pair**, then put the public key in `.env` as `PUBLIC_KEY`. Commerce signs each request and sends the base64 signature in `x-adobe-commerce-webhook-signature`. With `raw-http: true`, `__ow_body` arrives base64-encoded, and the action verifies the signature over that base64 string as received, then decodes and parses it. That follows Adobe's App Builder sample (`verifier.update(params.__ow_body)`, then `JSON.parse(atob(params.__ow_body))`). Adobe's Express sample instead verifies over `Buffer.from(JSON.stringify(body)).toString('base64')`; if the body arrives as JSON text, the action does the same. The payload follows the hook's field `name`, so `name="product.sku"` arrives as `{ "product": { "sku": "..." } }` and the action reads `product.sku`. Verified on Stage (see below). A missing or invalid signature, or a signed payload without a SKU, answers `{ "op": "exception" }`. Regenerating the key pair invalidates the old key at once: update `.env` and redeploy together.

A PEM has line breaks, and `.env` is one line per variable. Write the key on one line with `\n` for each break; the action turns `\n` back into newlines:

```text
PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEF...\n-----END PUBLIC KEY-----
RESTRICTED_SKUS=RESTRICTED-1,RESTRICTED-2
```

Verified on a real Stage instance: the signed path from Commerce reached the action and passed the check. Not verified: `required="true"` fail-closed behaviour, and end-to-end checkout timing (only runtime activation figures were taken).

## API Mesh (Ep 8)

`mesh/mesh.json` puts Commerce GraphQL and a REST reviews API behind one endpoint. A mesh belongs to one workspace, so select yours first with `aio console workspace select`. Replace the `example.com` endpoints, then:

```bash
aio plugins:install @adobe/aio-cli-plugin-api-mesh
aio api-mesh:create mesh/mesh.json
aio api-mesh:status
aio api-mesh:describe
```

The `responseSchema` path is relative to `mesh.json`, so `reviews-schema.json` must stay next to it. The REST handler is spelled `JsonSchema`; `jsonSchema` is rejected at create (`Unsupported property jsonSchema`). Source names: an update with a hyphen or a space was rejected and the service accepted an underscore, but Adobe's docs say letters and numbers only. A referenced file's name may be 25 characters including `.json`; 26 was rejected by the CLI, and a longer folder path was accepted. Only `SimpleProduct` gets `externalReviews` here (not `reviews`: Commerce's own schema already has a `reviews` field on products, and the mesh build fails on the clash); repeat the type extension and resolver for `ConfigurableProduct` and other product types you sell.

The reviews endpoint must answer `/reviews?skus=A,B` with one list per SKU, in the order asked (an array of arrays); that's how the batched join maps results back to products. On a Stage workspace the mesh wrote the array comma separated, as `skus=A,B`. It maps by position, not by `sku`: a reversed answer gave 16 of 17 products the wrong reviews with no error, and a list one short made all 17 `externalReviews` `null` with errors.

- **Off by default.** `"cache": true` in `responseConfig` turns it on. If you bring your own CDN, set `"cache": false` so responses aren't cached twice. With it off the answer has no `Cache-Status` but still carries the source's `Cache-Control`. With it on, expect a few `MISS` before the first `HIT`: several edge caches sit behind the endpoint and each fills on its own. Read `Cache-Status` and `Age`.
- **The response is the unit.** Query-level caching isn't supported. A response gets one set of `Cache-Control` headers and is cached as a whole. The key is the whole query: a reviews-only query and a reviews-plus-stock query were separate entries.
- **Sources vote, the lowest wins.** Conflicting `max-age`, `s-maxage`, `stale-while-revalidate`, `stale-if-error` and similar resolve to the lowest value. Seen with `max-age`, `s-maxage` and `stale-while-revalidate`; `stale-if-error` was not tried.
- **`no-store` beats everything.** If any source says `no-store`, the whole response is `no-store` and the answer has no `Cache-Status`. `private` is not cached either. Commerce answered `no-store` on the staging used, so a query that touches Commerce is never cached by the mesh.
- **Mesh config can't override a source.** A default set on a source (`responseConfig.cache.cacheControl` inside that source) applies only when the source sends no `Cache-Control`. A source's own header wins, `no-store` included. Change the source to change its lifetime.
- **GET length.** Adobe documents a limit of 2,048 characters. It was not enforced on the sandbox edge: GET URLs up to 32,768 characters answered 200. Don't rely on either number. A CDN of your own usually caches GET only. The same query as GET and as POST looked like two cache entries.
- **Purge after a mesh change:** `aio api-mesh:cache:purge -a`, or your CDN's purge. An update does not purge: a cached query kept answering `HIT` after one.
- **CORS is not access control.** A request with any `Origin` I sent got the configured origin back, so a browser blocks it, but the query still ran. The preflight answer had `Access-Control-Allow-Credentials: true`, which was not configured.
- **A failing source:** a source answering 500 gave an HTTP 500 from the mesh with all products still in the body, `externalReviews: null` on each simple product and one error for each. A source answering 200 with invalid JSON gave HTTP 200 and the same body. Each error's `extensions` held the full source URL and the source's error text. The error answer still carried the source's `Cache-Control`.
- **A slow source:** the mesh waited 55 seconds for the reviews source and returned everything (Runtime's 60-second limit stopped the test). A `timeout` property in the `JsonSchema` handler is rejected at create (`Unsupported property timeout used in /meshConfig/sources/1/handler/JsonSchema`), and Adobe's handler docs list no timeout option: time out inside the source and in the client.
- **`includeHTTPDetails`** exposes each source's request and response headers and the caller's IP address. Turn it off in production.

## Admin UI SDK (Ep 9)

`src/commerce-backend-ui-1/` is an Admin UI SDK **v1** extension (`extensions: commerce/backend-ui/1` in `app.config.yaml`). Its layout and registration fields are copied from Adobe's [custom-menu sample](https://github.com/adobe/adobe-commerce-samples/tree/main/admin-ui-sdk/v1/menu/custom-menu): a `registration` web action returns `menuItems` (`id`, `title`, `parent`, `sortOrder`, plus the sample's `Apps` section with `isSection: true`) and `page.title`; `web-src/` is the sample's bootstrap (`exc-runtime`, `register`, `attach` for the IMS token, `callAction`) with React Spectrum tables. The menu item is **Stuck orders** under the sample's **Apps** section; no new section.

On Stage, an error answer from `retry-delivery` (a 502 by the code) reached the page as HTML instead of the action's JSON (most likely the gateway replaces 5xx bodies), so the page reads the body as text and shows `HTTP <status>` when it isn't JSON.

- `list-alerts`: `find({ handled: { $ne: true } }).sort({ at: -1 }).limit(50)` on `stuck_alerts`, as in the post.
- `mark-handled`: needs `order` (400 without it, 404 for an unknown order), then `updateOne` setting `handled: true` and `handledAt`.
- `list-deliveries` (Ep 10): the recent `export_runs` rows that have an `order` field (Ep 4's sync-log rows share the collection and are left out), failures first (`dead`, then `retry`, then `sent`), newest first within each, at most 50. It returns `order`, `status`, `attempts`, `lastError`, `httpStatus`, `at` and `nextAt` only: never `mapped`, which holds the customer and addresses.
- `retry-delivery` (Ep 10): needs `order` (400 without it). A `retry` row gets `nextAt` = now, so the next retry run resends the stored order. A `dead` row keeps no order (no personal data), so Retry fetches it again from Commerce (`GET {COMMERCE_BASE_URL}/rest/V1/orders` filtered by `increment_id`, bearer `COMMERCE_TOKEN`, the inputs of `ops/stuck-orders`), maps it with `actions/order-sync/mapper.js` (which already reads the REST shape, including the shipping address under `extension_attributes.shipping_assignments`, so no adapter), and writes the row back as `retry` with `attempts` 0, `nextAt` now and the fresh `mapped` order. Answers: 404 for no such row or an order Commerce doesn't have, 502 `commerce error` when Commerce fails, 409 for a `sent` row (or a row that became `sent` while Commerce was asked: the update filters on `status: 'dead'`, so a sent row is never touched).
- The page has two tabs, **Stuck orders** and **Deliveries**; the table shows order, status, attempts, last error and time, with a **Retry** button on `dead` rows (a `retry` row is already due at the next run; the action still accepts one and makes it due now). A `retry` or `dead` row of an order that also has a `sent` row is left out of the list. The Commerce call times out after 10 seconds (502).
- `stuck-orders` (main only; the tags `ep1` and `ep3` don't move) upserts a `stuck_alerts` row per alerted order after the alert went out and was remembered. `handled` and `created_at` are set on insert only, so a re-alert (State's 7-day TTL expired, order still stuck) refreshes `status` and `at` but doesn't reopen a handled row. A database failure is logged by message and never blocks or repeats the alert, like the Files report. It needs `include-ims-credentials: true`, now set in `app.config.yaml`.

**Client allowlist.** The four page actions also check the token's `client_id` against `ALLOWED_CLIENT_IDS` (comma-separated, set in `.env`). Unset or empty means every call answers 500 (fails closed). The refused `client_id` is logged at warn level in the action's logs (`aio rt activation logs`), which is how to find the value to put in `ALLOWED_CLIENT_IDS` on the first run.

**Enable it in the admin.** The admin needs [Adobe IMS sign-in](https://experienceleague.adobe.com/en/docs/commerce-admin/start/admin/ims/adobe-ims-config), which applies to every admin user: without it the App Registry call fails with 401 "Oauth token is not valid" and the extension list stays empty. The SDK looks up extensions in the signed-in admin's IMS org, so that must be your App Builder project's org. `bin/magento admin:adobe-ims:enable -n` wants the 2FA option as `yes` (`1` is refused). Then Stores > Settings > Configuration > Adobe Services > Admin UI SDK: set **Enable Admin UI SDK** to Yes, select the app under **Configure eligible extensions** (pick the workspace; a `--no-publish` deploy is listed as **Draft** for Stage, and **Save** also refreshes the registrations), and after every `aio app deploy` click **Refresh selected extensions**. **Database logging** writes the SDK's logs to System > Admin UI SDK > Admin UI SDK Logs.

**Local testing.** `aio app dev` with **Enable local testing** and **Local Server Base URL** in the same section works on PaaS and with v1 only; on Commerce as a Cloud Service local testing must stay off. `web-src/src/config.json` (action URLs) is generated by `aio app build` and `aio app dev` and is git-ignored.

**"Admin-only" means `require-adobe-auth: true`.** The four page actions are web actions that accept only a valid Adobe token for the org, and the page sends the signed-in admin's token. v1 has no per-action ACL: without the `client_id` allowlist, any user of the org with a token could call them (on Stage a valid CLI token with the org header got 403 from the allowlist, the admin's token 200), so don't put anything beyond "list and acknowledge alerts" behind them. ACL-protected menu items and actions are a v2 feature.

**Version 2.** `commerce/backend-ui/2` declares menus (and grid columns, mass actions, order-view buttons) in an `adminUi` block of the app's Commerce configuration instead of a registration action. This repo uses v1 because that's what Adobe's samples show; the two aren't compatible, so pick one per app. Not built here.

**What's verified.** The registration shape, `list-alerts`, `mark-handled`, `list-deliveries`, `retry-delivery` (including the next retry run picking the re-queued row up) and the `stuck_alerts` writes are unit-tested with the database faked. The React page is **not** covered by `npm test` or CI (it needs the aio CLI, a bundler and a Commerce admin); it was checked by hand once, deployed to Stage and loaded in a local Commerce admin (see "What's verified" below); under `aio app dev` with Admin UI SDK local testing, the menu was read but the page was not opened (Ep 11). Its dependencies (React, React Spectrum, UIX, exc-app) are `devDependencies` only: the actions don't need them. The page needs them to build, so run `aio app build` or `aio app dev` after a full `npm install`, not `--omit=dev`.

## Test helper: fake ERP

`actions/fake-erp` (action `dev/fake-erp`) is a small fake ERP, so a real-workspace run has something to send orders to. It is a test helper, not part of the order-sync design. `POST /orders` stores the order in State for seven days (`201`, or `409` if it already has that order number); `GET /orders?order=<n>` reads it back (`200` or `404`). Every request needs `Authorization: Bearer <FAKE_ERP_API_KEY>`; an unset, empty or shorter-than-16-character key refuses everything with `401`. An order number outside `[A-Za-z0-9_.-]{1,64}` gets `400`.

Orders it receives (they may include customer data) stay in State for 7 days, so use it in test workspaces only. A State failure answers `503` (erp.js retries it); a stored order over 64 KB answers `413`.

It is a public web action and deploys with every `aio app deploy`, including a Production workspace. Remove the `dev` package from `app.config.yaml` (or `aio app undeploy`) when you don't need it.

To use it, set `FAKE_ERP_API_KEY` and `ERP_API_KEY` to the same value in `.env` and point `ERP_API_URL` at the action: `https://<namespace>.adobeioruntime.net/api/v1/web/dev/fake-erp`.

## What's verified

Each piece is marked by how far it has been proven:

- **Unit-tested:** `npm test` (389 tests, run in CI on Node 20 and 24) runs the actions with Commerce, the ERP, the alert webhook, State, Files and Database Storage faked. The database fake (`fakeDb` in `test/helpers.js`) supports equality, `$or`/`$and`, `$ne`, `$in`, `$lt`/`$lte`/`$gt`/`$gte`, `find().sort().limit().toArray()`, `updateOne` with `$set` and upsert, unique indexes, and throws `DbError`; it proves our logic, not the real service. The State fake behaves like aio-lib-state 5.4 where it matters: `ifNotExists` (the retry lock). That proves the mapping, retries, skipping a redelivered event, the retry rows, the lock, time budget, dead rows without personal data, one row per order across sent, retry and dead, no ERP body or error object in any log line, the stuck-order query, alert-then-remember, the report, and the webhook's signature check (real RSA keys, a tampered body, a base64 body, an escaped-newline PEM, a missing key answering 500). It doesn't prove a deployment. The fake ERP test helper is unit-tested the same way (State faked).
- **Verified on a real Stage workspace** (several runs, Adobe Commerce on cloud infrastructure with commerce-eventing 1.23.0):
  - `aio app deploy --no-publish -e application` built and deployed the seven application actions on `nodejs:20`.
  - Database Storage was provisioned in `emea`. The post-deploy hook created the six indexes with the real OAuth credential (scopes as the JSON array `aio app use` writes).
  - `dev/fake-erp` answered 201, 409, 401, 400 and GET 200. Runtime refused a request body carrying `FAKE_ERP_API_KEY` with 400 (`final: true`).
  - A subscription to `observer.sales_order_place_after` with flat field names (`increment_id`, `grand_total`) delivered `data.value` as an empty object. Commerce still marked the event sent, and the handler answered 400.
  - With `order.increment_id` and `order.grand_total`, one real order was delivered by I/O Events to `events/order-placed`. It answered 200, sent the order to the fake ERP once, and wrote one `sent` claim and one `sent` row.
  - The I/O Events delivery trace showed the action's returned 400 and 200 as the delivery's response status.
  - Invoking the action again by hand with the same payload answered `{ skipped: true }` with no second send. That was a manual invoke, not an I/O Events redelivery.
  - A scratch Runtime action that always returned 503, registered as the consumer of a scratch event, was retried by I/O Events three times, 60, 120 and 240 seconds after the previous attempt. Watching stopped after the fourth attempt, so the later schedule and the 24-hour limit are from the docs only. A scratch action returning 409 got one attempt and no retry in the 7 minutes watched. 500, 429 and 505 were not measured, and `events/order-placed` itself has not been redelivered.
  - Two concurrent `aio rt action invoke` calls of `events/order-placed` with the same made-up order answered one 200 and one 503 (`in progress, retry later`). They left one `order_claims` document with exactly `{ order, status, at }` plus `_id`, and one `sent` row. These were manual invokes, not I/O Events deliveries; the fake ERP keeps one record per order, so it can't show how many POSTs arrived.
  - `order-sync/sync-log` invoked by hand inserted a row and returned it as `lastFailure`; `aio app db document find` read it back; a missing `sku` answered 400.
  - Enabling the `stuckOrdersSchedule` rule made the `every15Minutes` alarm trigger fire on the quarter hour and start `ops/stuck-orders`. With no Commerce credentials deployed, the action returned an error body inside a `success` activation, so the job itself is still unverified. The Ep 3 REST query, run from a local script against Commerce staging, answered 200 with only the three fields; an empty result is `{"items":null}`.
  - Ep 7 webhooks (Adobe Commerce 2.4.8-p5): `webhooks:list` showed the hook(s) after a deploy, and `webhooks:dev:run observer.checkout_cart_product_add_before:before` (type suffix required) blocked `MMTEST-RESTRICTED-1` with the action's message and passed `MMTEST-OK-1`; with a non-matching SKU the `MMTEST-` rule skipped the call with no activation, yet the CLI still printed "successfully processed". With digital signatures enabled, the signed path passed the action's signature check. `webhooks.xml` changes need a push and redeploy. A first run allowed everything because `RESTRICTED_SKUS` was unset in `.env`; after setting it and redeploying, both hooks blocked the restricted SKU.
  - Ep 7 storefront and API: with only `observer.checkout_cart_product_add_before`, the storefront add-to-cart of the restricted SKU was blocked (the cart stayed empty), while GraphQL `addProductsToCart` and REST `POST /V1/guest-carts/{id}/items` added it with no activation. With `observer.sales_quote_add_item` as well, GraphQL returned `items: []` and `user_errors` code `UNDEFINED` with the message, and REST returned HTTP 400 with the message; the OK SKU was added on both. Runtime activation figures from the scratch action used in the first deploy (no signature verification): a cold start waited 118 to 127 ms, with 13 to 14 ms init and 16 to 17 ms run; a warm call took about 3 ms.
  - Ep 3 on Stage: State stored a string value with a 7-day time to live, a deploy created the trigger and the rule, and `aio rt rule disable` stopped them.
  - State with aio-lib-state 5.4.0, called from a local script: of three concurrent `put` calls with `ifNotExists`, one won and two got `null`; the key freed after its TTL and after `delete`.
  - Ep 10 on a Commerce Cloud staging: `order-sync/export-order` registered in Developer Console as the only consumer of `observer.sales_order_place_after` and run by I/O Events, and `export-order-retry` running every 10 minutes (an empty run succeeded).
  - Ep 10 nested and array `--fields`: `order.items` works. `order.shipping_address` arrives as null; resubscribed with `order.addresses`, and the mapper's fallback picks the shipping address.
  - Ep 10 `events:subscribe` with two event providers on one Commerce instance: the first subscribe went to the default provider. `--providerId=<id>` sent it to the provider the registration listens on.
  - Ep 10 `findOne` on no match: aio-lib-db 1.1.0 throws `DbError ... failed: Document not found` instead of returning null, so the first orders failed with a 500. `store.js` now has `findOneOrNull`. The Retry delivery admin action called `findOne` the same way and got the same fix (code only; not run on Stage). After the fix was deployed, Adobe I/O Events redelivered the events that got the 500 and they went through. With no `sent` row yet, `markDone`'s `updateMany` plus `insertOne` worked on Stage.
  - Ep 10 side by side with the PHP module `commerce/OrderExport` (both on, one test customer): the order lines and the address were identical in the fake ERP. On a normal order the app sent 9.1 s after the module.
  - Ep 10 failure test: with both senders pointed at an unreachable ERP, the app row became `retry` (attempts 1, "ERP unreachable: fetch failed") and the module row stayed `pending`. After the ERP address was restored, `export-order-retry` resent the order and the row ended `sent` (attempts 4); the module delivered on its sixth attempt, its last. The app's `sent` row still showed the old `lastError` (fixed in `store.js`: a `sent` row now clears `lastError` and `httpStatus`; `attempts` stays as history).
  - Ep 10 switch-over: with the module disabled, a new order reached the fake ERP from the app only, and the module left no retry row.
  - Ep 10 notes: the PHP module's retry budget is six attempts, ten minutes apart, while the app's run is its own schedule (every 10 minutes, up to six runs). `aio rt activation list` lagged and left out recent activations; `aio app db document find` was the reliable check. The app side has no test filter, so on a shared staging it exports every order, including ones that are not yours.
  - `require-adobe-auth`: an action created with `aio rt action create` and the annotation stayed public (200 without a token). The sequence `aio app deploy` builds (Adobe's `headless-v2` validator in front of `__secured_<name>`), made by hand, answered 401 without a token, with a made-up token, and with a valid token but no `x-gw-ims-org-id`, and 200 with both. The deploy path itself was run in the Ep 9 run (bullets below).
  - Ep 5 log forwarding to New Relic (EU region): `aio app config set log-forwarding` applied with no deploy and sent its own test line ("Test from Adobe IO Runtime"); `get` showed only the destination and `base_uri`; the errors command printed "No log forwarding errors for the last configured destination 'new_relic'". Successful blocking web calls were forwarded. In four warm runs each line was queryable within about 10 to 12 seconds of the request (upper bound: one Logs UI search took about 10 s); the first run's line was there when first looked at, about 1.5 minutes later, and was not timed. The stored timestamp was 1.2 to 3.1 s after the request. Attributes: `action`, `action_short`, `activation_id`, `log_message` (the whole line with the logger prefix), `log_stream`, `log_timestamp`, `namespace`, `newrelic.source`, `plugin.type`, `plugin.version`, `timestamp`; no `message` or `level` (an error line arrived on `stdout`). While forwarding was on, `aio app logs` and `aio rt activation logs` both refused with "Namespace is configured with custom log forwarding destination"; after switching back, both showed the lines from that window, so Runtime kept them. With forwarding off, a successful blocking web call still had its log line in Runtime, unlike the docs ("only for failed or asynchronous"). A later application deploy re-sent the local setting ("Log forwarding is set to 'adobe_io_runtime'").
  - Ep 9 Admin UI extension, Stage workspace with a local Adobe Commerce (admin IMS on, SDK v1): `aio app deploy --no-publish -e commerce/backend-ui/1` deployed five actions and the web assets and left the rules alone. The app was listed as **Draft** under Configure extensions for Stage without a publish; Save wrote the selection, a `selected_workspace` setting and a "Registrations refreshed successfully" log. The Apps menu showed the page; it loaded in the admin iframe, listed test alerts newest first and the Deliveries rows. Mark handled set `handled: true` and `handledAt` (the page's immediate re-list was stale once out of two tries; not conclusive). The deployed `list-alerts` answered 401 with no token, a made-up token, and a CLI token without the org header, and 403 with a CLI token and the org header (the `client_id` allowlist; the admin's token got 200); `registration` answered 401 with no token. Successful calls of these `require-adobe-auth` sequences left no entry in `aio rt activation list`, while 401s did, at once.
  - Ep 9 Retry on a `dead` row with no Commerce credentials deployed: the row stayed `dead`, and the page failed to parse an HTML body ("Unexpected token '<'"). A 401 through the same route came back as JSON, so the gateway most likely replaced the action's 502 body (inferred). No "Cannot find module" error, and no failed activation listed, so `mapper.js` is bundled (inferred from the absence).
  - Ep 8 API Mesh on Stage (aio-cli 11.2.0, api-mesh plugin 5.7.2, a Commerce staging instance, a reviews API running as a Runtime action): `create` with `jsonSchema` was rejected at validation and with `JsonSchema` accepted. The first build failed on `Field "SimpleProduct.reviews" already exists in the schema`; after the rename to `externalReviews` it built, and builds took one to two minutes. Source names with a hyphen or a space were rejected at update and an underscore was accepted. A file name of 25 characters including `.json` was accepted, 26 was rejected by the CLI, and a longer folder path was accepted.
  - Ep 8 join: a product-list query with 17 simple products made one reviews call with the 17 SKUs written as `skus=A,B` (three repeats), against 17 calls with `sourceArgs`. Median 2.8 s against 3.9 s over three runs; the times include the fake's State calls and Runtime cold starts. A reversed answer gave 16 of 17 products the wrong reviews with no error, a list one short made all 17 `null` with errors, and a result with the `sku` dropped gave `[null]` per product with errors.
  - Ep 8 cache: off by default (no `Cache-Status`, the source's `Cache-Control` still passed through). On, a repeated query was `MISS` then `HIT` with `Age` rising, but several independent edge copies filled separately (five `MISS`, two `HIT`, two `MISS`, three `HIT` in one run). The key is the whole query. The lowest `max-age`, `s-maxage` and `stale-while-revalidate` won. `no-store` and `private` were never cached, and Commerce answered `no-store`, so any query with a Commerce field was never cached. A per-source default (`max-age=100`) applied only to a source that sent no header. A purge cleared the entries; an update with the same file did not. GET and POST of the same query looked like separate entries.
  - Ep 8 transport and errors: CORS returned the configured origin for any Origin sent, with `allow-credentials: true` on the preflight. GET URLs up to 32,768 characters answered 200. A 500 source gave HTTP 500 with data in the body, bad JSON gave HTTP 200, errors carried the full source URL, and the 55-second slow source was waited for in full. `includeHTTPDetails` exposed request and response headers and the client IP. The mesh was deleted after the run. In a later run, a `timeout` property in the `JsonSchema` handler was rejected at create; no mesh was created.
  - Ep 11 local testing (2026-11-21, aio-cli 11.2.0, a local Adobe Commerce on Warden, the Stage workspace; notes in `dev/run-ep11/README.md`): `aio app dev -e application` (one extension per run) served web and non-web actions on `https://localhost:9080`; `require-adobe-auth` only checks that `Authorization` and `x-gw-ims-org-id` are there. State from localhost worked both from a plain Node script with the namespace credentials and inside an action under `aio app dev` (Adobe's troubleshooting page says localhost is not authorized); Files failed both ways with `ERROR_BAD_CREDENTIALS`; Database Storage worked both ways against the workspace's real database. A process env variable beats `.env` under `aio app dev`; a query param does not override an action input. A saved order event fed to `events/order-placed` under `aio app dev` wrote to the Stage database; a journaling registration was read from a local script (`dev/journal-pull.js`, dry run, 0 events) and deleted. `aio app dev` has no trigger or alarm handling; `wskdebug` on `ops/stuck-orders` failed (the agent's polling got 502 from Runtime); enabling `stuckOrdersSchedule` again fired the action at the quarter hour (success, 9 s wait). `aio api-mesh run` served the Ep 8 mesh on local Node with one batched reviews call and no cache headers. With Admin UI SDK local testing on (module 3.4.1), the admin read a local registry stand-in and the `registration` action under `aio app dev` and built the "Stuck orders" menu. Webhooks: `aio app dev` ignores the `raw-http: true` annotation (only `web: 'raw'` counts), so `cart-check` gets no `__ow_body` and refuses every signed call locally; local Commerce reached the deployed action with `webhooks:dev:run`.
- **Still unverified:**
  - I/O Events retry on 429, the retry schedule after the fourth attempt, the 24-hour limit, and a real redelivery to `events/order-placed`. (A 500 from `order-sync/export-order` was redelivered; the timing was not measured.)
  - The duplicate-key error text and code, and a second claim after `sent` arriving as an I/O Events delivery.
  - The `dead` state after retries run out (the run inserted `dead` rows by hand), the admin Retry button with Commerce credentials (the run covered only the no-credentials error), the 409 for a `sent` row, a server-to-server credential's token against the allowlist, and `stuck-orders` with real Commerce credentials and a real alert.
  - Ep 7: end-to-end checkout timing (the activation figures above are Runtime only), `required="true"` fail-closed behaviour, the message text shown on the storefront page (the block was seen in the activation and the empty cart, the message was not captured), storefront add-to-cart with `observer.sales_quote_add_item`, and the double firing of both hooks on one storefront add.
  - API Mesh: a `timeout` on the `graphql` or `openapi` handler, how long the mesh waits past 55 seconds, a CDN in front of the mesh with `"cache": false`, real traffic and hit ratios, a mesh in a second workspace, `stale-if-error`, and updating the mesh after a source's schema changes.
  - The Admin UI extension: Adobe's sample, the page in the admin iframe under local testing (the menu was read, the page was not opened), the self-signed `aio app dev` certificate in a real admin request, the Refresh selected extensions button on its own, and version 2.
  - Ep 11: the signed webhook path under `aio app dev` (blocked by the `raw-http` finding), `wskdebug` on any action, the API Mesh edge cache locally (docs only), and a live order through I/O Events to a local handler.
  - Log forwarding: a wrong region or key, a deploy with New Relic forwarding on, a cold action's latency, a second workspace, the 10 MB cut-off and `LOG_LEVEL` filtering.

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
  CartCheck/                    # Ep 7 run: ready-made module MageMinion_CartCheck (the hook fires only for MMTEST- SKUs)
  OrderExport/                  # Ep 10 run: the "old" order-export module MageMinion_OrderExport (observer, retry cron)
dev/
  run-ep7/                      # Ep 7 run: scratch action, webhooks.xml variants A/B/C, curl recipes
  run-ep10/                     # Ep 10 run: side-by-side steps
mesh/                           # Ep 8: mesh config and the reviews response schema
scripts/
  post-deploy-db-setup.js       # Ep 4: post-app-deploy hook, creates the indexes
  compare-erp.js                # Ep 10 run: compares the app's and the module's records in the fake ERP
app.config.yaml                 # actions, two alarm triggers and their rules, database, post-deploy hook
test/                           # Jest unit tests (everything external faked)
log/                            # developer-log write-ups, one per tag
```

Licence: Apache-2.0 (`LICENSE`, `NOTICE`).
