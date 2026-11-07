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
| `ep6-commerce-events` | [Ep 6: replace an observer with a Commerce event](https://mageminion.com/app-builder-ep6-commerce-events/) | `events/order-placed`: handles `observer.sales_order_place_after` from I/O Events with only `increment_id` and `grand_total`, claims the order atomically in `order_claims` (unique index on `order`) before sending, so two deliveries of the same order can't both send, then sends it to the ERP (Idempotency-Key = order number), records the `sent` row, and answers 500 on failure so I/O Events retries |
| `main` | Beyond Ep 1: order sync to an ERP | `export-order` grown into an event-driven integration (below), plus fixes to `stuck-orders` from a code review. Not in a published episode yet |
| `day-NN` | Developer log | One tag per session, with its write-up in [`log/`](log/) |

## Order sync to an ERP

In Ep 1, `export-order` was a web action behind Adobe auth that only checked its inputs. On `main`, Adobe I/O Events invokes it directly, so it is a non-web action with no public URL, and it does the work:

1. **Commerce** publishes `observer.sales_order_place_after` through Adobe I/O Events.
2. **`order-sync/export-order`** receives it, maps the order with `actions/order-sync/mapper.js` and POSTs it to `ERP_API_URL/orders` with a Bearer key and the order number as `Idempotency-Key`.
3. **Retries:** network errors, 429 and 5xx get up to three tries with backoff in the same call. If the ERP is still down, the mapped order is queued in State (`order-sync.retry.*`, 7 days) and **`order-sync/export-order-retry`** resends it every 10 minutes, one try per order per run, for up to six runs in total. A run stops at `MAX_PER_RUN` orders or after 240 seconds, whichever comes first, and reports what's `left` for the next run. A State lock stops a manual invoke from overlapping the scheduled run.
4. **Duplicates:** a delivered order is remembered for 30 days (`order-sync.done.*`), so a redelivered event isn't sent twice. Two deliveries that race (a redelivery while the first is still running) can both POST; the ERP's `Idempotency-Key` makes the second a 409, which counts as success. The ERP is the guarantee; State is the fast path.
5. **Failures for a human:** a 4xx from the ERP, or an order still failing after the last run, lands in `order-sync.dead.*` for a year, with the order number, lines, totals, status and last error. The customer and addresses are left out (look them up in Commerce), and ERP response bodies are only logged at debug level, because ERPs often echo the request.
6. **Return codes:** the handler answers 200 for exported, skipped, queued, dead or malformed events, and an error only when it couldn't record anything (State down) or settings are missing, so I/O Events redelivers those. I haven't verified I/O Events' retry schedule for runtime-action consumers yet; check the [Events docs](https://developer.adobe.com/events/docs/) before relying on it.

The ERP side is generic: change `mapper.js` for your ERP's order shape and `erp.js` if its API differs (URL, auth, duplicate status).

### Wire it up

Check the `--fields` syntax for nested data (items, addresses) against the Adobe I/O Events for Commerce docs for your Commerce version before you run this, and confirm with `bin/magento events:list` and one test order:

```bash
# Commerce: send the event, with the fields mapper.js reads
bin/magento events:subscribe observer.sales_order_place_after \
  --fields=increment_id --fields=created_at --fields=order_currency_code --fields=grand_total \
  --fields=shipping_amount --fields=tax_amount --fields=customer_email \
  --fields=customer_firstname --fields=customer_lastname --fields=billing_address --fields=items
aio app deploy
```

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

**Indexes.** `hooks.post-app-deploy` runs `scripts/post-deploy-db-setup.js` after every deploy. It reads the workspace's OAuth credentials from `.env` (`IMS_OAUTH_S2S_CLIENT_ID`, `_CLIENT_SECRET`, `_ORG_ID`, `_SCOPES`) plus `AIO_RUNTIME_NAMESPACE` (see `.env.dist`; `aio where` shows the namespace). The namespace is passed to `init` explicitly, because aio-lib-db otherwise reads `__OW_NAMESPACE`, which isn't set when aio runs a hook, gets a token, and creates the indexes below. Indexes that exist are skipped, so a second deploy changes nothing. `ensureIndexes(client)` is the pure part and is what the tests call. The hook is written as `node scripts/post-deploy-db-setup.js`, so it doesn't depend on the file's execute bit.

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
| `export_runs` | Ep 4: `sync-log` | `sku`, `status`, `error` (or `null`), `at` (ISO time) | `{ sku: 1, at: -1 }`, `{ order: 1, status: 1 }` |
| `export_runs` | Ep 6 (after its claim) and Ep 10: order rows | `order`, `status` (`sent`, `retry` or `dead`), `at`; optional `attempts`, `nextAt`, `lastError`; `mapped` on `retry` rows only (no customer or address blocks); lines and totals on `dead` rows only (no customer). Ep 6 claims the order in `order_claims` first, not by looking at this collection | same collection, same indexes |
| `order_claims` | Ep 6: `events/order-placed` | `order`, `status` (`sending`, `sent` or `failed`), `at` (ISO time, always `toISOString()`: the stale check compares it as a string) | unique `{ order: 1 }` |
| `stuck_alerts` | Ep 9 | `order`, `status`, `created_at`, `at`, `handled` (boolean), `handledAt` (optional) | unique `{ order: 1 }`, `{ handled: 1, at: -1 }` |

Ep 6 claims each order in `order_claims` and writes the `sent` order rows (`events/order-placed`). The Ep 10 rows (`retry`, `dead`) are planned and not in the code yet; the indexes for them are already created by the hook.

## Commerce events (Ep 6)

`events/order-placed` is the handler from the post: Adobe I/O Events delivers `observer.sales_order_place_after`, and the action sends the order to the ERP once. It reads `params.data?.value ?? params.data`, answers 400 (logging only the data keys) when there's no `increment_id`, claims the order, sends it with `sendToErp` (the post leaves that out; here it is in `actions/order-placed/index.js` and reuses `actions/order-sync/erp.js`, so the order number is the `Idempotency-Key` and a 409 counts as success), then upserts the `sent` row (`updateOne({ order, status: 'sent' }, { $set: { at } }, { upsert: true })`, so a repeat never adds a second one and a retry or dead row is left alone) and marks the claim `sent`. The claim is one `updateOne` with `upsert` on `order_claims`: it matches a claim that is `failed` or `sending` for more than 10 minutes, or inserts a new one, and the unique index on `order` rejects the insert when a `sent` or fresh `sending` claim exists. On any error from that call the action reads the claim: `sent` answers 200 `{ skipped: true }`, a fresh `sending` (another delivery is mid-send) answers 503 so I/O Events retries (it retries 429 and 5xx except 505 for up to 24 hours, and never a 409), and anything else answers 500. A failed send marks the claim `failed` so a redelivery can claim it again; if the process dies mid-send, the claim is claimable again after 10 minutes. If the `sent` row or the `sent` mark fails after a successful send, the next delivery sends again after that window and the ERP's `Idempotency-Key` makes it a 409. The order number must match `/^\S{1,64}$/`, else 400. Any error answers 500 so a retry is possible, and an event it can never process (no order number) answers 400, as in the post. That a Runtime action's returned `statusCode` is treated like a webhook response is not verified on Stage yet. A permanent ERP error (400/422) also returns 500 here, so each redelivery POSTs again; Ep 10's `export-order` dead-letters those instead. `export-order` answers 200 for malformed events while `order-placed` follows the post's 400, because an unprocessable event shouldn't count as a delivery failure against the registration. `sendToErp` stays in `index.js` because it is one small helper; the post's tip about its own file applies once it grows. The database client is closed in `finally`. The claim isn't on `export_runs` because Ep 4 rows have no `order` field, and a unique index treats all missing values as equal. **Verify on Stage:** the exact error text of a unique-index violation on Adobe's service (message and code) has not been captured; the action decides from the claim document, and the error only picks the log level, but run one real duplicate upsert and record what comes back. Also check on Stage that one upsert with the claim's `$or` filter creates a document with exactly `{ order, status, at }` (the fake copies equality fields from the filter, as MongoDB does; a multi-clause `$or` adds nothing), that two concurrent claims for one order give exactly one duplicate-key error, and that a Runtime action's returned 503 or 500 starts an I/O Events retry the way the docs describe for a webhook response (unverified).

```bash
# Commerce (PaaS): the event provider, then the subscription with only the fields the handler needs
bin/magento events:create-event-provider --label "Shop Stage" --description "Commerce events from Stage"
bin/magento events:subscribe observer.sales_order_place_after \
  --fields=increment_id --fields=grand_total --priority
bin/magento events:list
aio app deploy
```

Then, in Developer Console, in the workspace: **Add service > Event > Commerce events**, pick the provider, tick `observer.sales_order_place_after`, and choose the runtime action `events/order-placed` as the consumer.

**Duplicates.** Commerce retries sending events to Adobe I/O, up to 7 times by default, so the same order can arrive more than once; the claim in `order_claims` is what makes that safe: two deliveries that race can't both win it, so only one POSTs. The ERP's `Idempotency-Key` is the second layer (a 409 counts as success), for the case where a send succeeded but its bookkeeping failed.

**Register only one.** `events/order-placed` and `order-sync/export-order` both consume the same event. `order-sync/export-order` is the full version, built in Ep 10 (retry queue, dead letters, mapped order), and `order-placed` is the minimal one this episode teaches. Register one of them as the consumer, never both, or every order is handled twice. Not verified on a real workspace yet.

## Log forwarding to New Relic (Ep 5)

Forwarding is set per workspace. Run this once for Stage and once for Production, each after `aio app use`:

```bash
aio app config set log-forwarding
? select log forwarding destination: New Relic
? base URI: https://log-api.eu.newrelic.com/log/v1
? license key: <your INGEST - LICENSE key>
```

The base URI depends on where you log in to New Relic. US (`https://one.newrelic.com/`): `https://log-api.newrelic.com/log/v1`. EU (`https://one.eu.newrelic.com/`): `https://log-api.eu.newrelic.com/log/v1`. Include the `https://`. A wrong region doesn't fail loudly; your logs just never arrive.

The license key is stored in `.env`, which stays out of git. The setting applies to the workspace as soon as `aio app config set log-forwarding` runs, not on the next deploy, and `get` shows the destination and base URI, never the key:

```bash
aio app deploy
aio app config get log-forwarding
```

A deploy with `--no-actions` or `--no-log-forwarding-update` skips the forwarding settings stored in `.aio` and `.env`, so use a normal deploy.

Run an action that logs, then open **Logs** in New Relic and look for the new lines:

```bash
aio rt action invoke ops/stuck-orders --result
```

Keep `LOG_LEVEL: info` in the action inputs (already set in `app.config.yaml`), and use `debug` only while you investigate. Forwarding sends what you write, and an action's logs are cut off after 10 MB per activation.

If nothing arrives, run `aio app config get log-forwarding errors`. It shows the most recent 10 forwarding errors, from up to 30 days back. The usual causes are the wrong regional base URI, a key that isn't an ingest license key, or a deploy that skipped the forwarding update.

Once logs leave the terminal, more people read them. Log one line per significant step, with the order number or SKU in it. Never log tokens, API keys or customer personal data. Log errors with the reason and the next action ("will retry in 15 minutes"), not just a stack trace.

## What's verified

Each piece is marked by how far it has been proven:

- **Unit-tested:** `npm test` (100 tests, run in CI on Node 20 and 24) runs the actions with Commerce, the ERP, the alert webhook, State, Files and Database Storage faked. The database fake (`fakeDb` in `test/helpers.js`) supports equality, `$or`/`$and`, `$ne`, `$in`, `$lt`/`$lte`/`$gt`/`$gte`, `find().sort().limit().toArray()`, `updateOne` with `$set` and upsert, unique indexes, and throws `DbError`; it proves our logic, not the real service. The State fake behaves like aio-lib-state 5.4 where it matters: `ifNotExists`, TTLs, and a paged `list()` that can return a key twice. That proves the mapping, retries, skipping a redelivered event, the retry queue, locks, time budget, dead-lettering without personal data, the stuck-order query, alert-then-remember and the report. It doesn't prove a deployment.
- **Verified on Stage:** nothing yet. The developer log marks code as verified once it has run in a real workspace.

## Run it

```bash
npm install
npm test
cp .env.dist .env        # fill in; never commit .env or .aio
aio app use <your-workspace>.json
aio where                # check before every deploy
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
  order-sync/                   # mapper, ERP client, State bookkeeping, export logic
  stuck-orders/index.js         # Ep 3
  sync-log/index.js             # Ep 4: Database Storage
  order-placed/index.js         # Ep 6: Commerce event handler, claims each order in order_claims
scripts/
  post-deploy-db-setup.js       # Ep 4: post-app-deploy hook, creates the indexes
app.config.yaml                 # actions, two alarm triggers and their rules, database, post-deploy hook
test/                           # Jest unit tests (everything external faked)
log/                            # developer-log write-ups, one per tag
```

Licence: Apache-2.0 (`LICENSE`, `NOTICE`).
