# App Builder learning log

Code for **Learn App Builder with me** on [MageMinion](https://mageminion.com/series/app-builder/): a Magento developer learning Adobe Developer App Builder from zero, in public, with Claude Code.

The series has two parts. Four foundation episodes, then a developer log written from real sessions. Every episode and every developer-log session gets a git tag, so you can check out exactly where the series was:

```bash
git checkout ep3-cron-state-files
```

| Tag | Episode | What's in it |
|---|---|---|
| `ep1-project-anatomy` | [Ep 1: the anatomy of a project](https://mageminion.com/app-builder-ep1-project-anatomy/) | The project layout, `app.config.yaml` (web action, inputs from `.env`, `require-adobe-auth`, `final`, limits), `.env.dist`, the `export-order` action |
| — | [Ep 2: start from a boilerplate](https://mageminion.com/app-builder-ep2-first-action/) | Ep 2 starts a real integration from Adobe's [commerce-integration-starter-kit](https://github.com/adobe/commerce-integration-starter-kit). Clone that kit; it isn't copied here |
| `ep3-cron-state-files` | [Ep 3: cron, config and custom tables](https://mageminion.com/app-builder-ep3-cron-state-files/) | `stuck-orders`: an alarm trigger and rule every 15 minutes, a Commerce REST query for orders stuck in `pending_payment`, one alert per order (State with a 7-day TTL), a State lock against overlapping runs, and an optional daily CSV report in Files (`SAVE_REPORT: true`) |
| `main` | Beyond Ep 1: order sync to an ERP | `export-order` grown into an event-driven integration (below). Not in a published episode yet |
| `day-NN` | Developer log | One tag per session, with its write-up in [`log/`](log/) |

## Order sync to an ERP

Ep 1 introduced `export-order` as a skeleton. On `main` it is a working integration:

1. **Commerce** publishes `observer.sales_order_place_after` through Adobe I/O Events.
2. **`order-sync/export-order`** receives it (I/O Events invokes the runtime action directly, so it has no public URL), maps the order with `actions/order-sync/mapper.js` and POSTs it to `ERP_API_URL/orders` with a Bearer key and the order number as `Idempotency-Key`.
3. **Retries:** network errors, 429 and 5xx get up to three tries with backoff in the same call. If the ERP is still down, the order is queued in State (`order-sync.retry.*`) and **`order-sync/export-order-retry`** resends it every 10 minutes, for up to six runs in total.
4. **Duplicates:** a delivered order is remembered for 30 days (`order-sync.done.*`), so a redelivered event isn't sent twice; a 409 from the ERP counts as success.
5. **Failures for a human:** a 4xx from the ERP, or an order that's still failing after the last retry, lands in `order-sync.dead.*` (kept a year) with the order and the last error.

The ERP side is generic: change `mapper.js` for your ERP's order shape and `erp.js` if its API differs (URL, auth, duplicate status).

### Wire it up

```bash
# Commerce: send the event, with the fields mapper.js reads
bin/magento events:subscribe observer.sales_order_place_after \
  --fields=increment_id --fields=created_at --fields=order_currency_code --fields=grand_total \
  --fields=shipping_amount --fields=tax_amount --fields=customer_email \
  --fields=customer_firstname --fields=customer_lastname --fields=billing_address --fields=items
aio app deploy
```

Then, in Developer Console, add an event registration in the workspace for `com.adobe.commerce.observer.sales_order_place_after` and pick the runtime action `order-sync/export-order` as its consumer. Check the field syntax (especially nested fields such as items and addresses) against the Adobe I/O Events for Commerce docs for your version.

### See what happened

```bash
aio app logs
aio rt activation list
aio rt action invoke order-sync/export-order-retry --result   # drain the retry queue now
```

## What's verified

Each piece is marked by how far it has been proven:

- **Unit-tested:** `npm test` (25 tests) runs the actions with Commerce, the ERP, the alert webhook, State and Files faked. That proves the mapping, retries, idempotency, dead-lettering, the stuck-order query, de-duplication and the lock, not a deployment.
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

Ep 3 needs a Commerce integration token with read access to Sales > Operations > Orders (on PaaS, also allow OAuth access tokens as standalone bearer tokens) and an incoming-webhook URL for the alert.

## Layout

```text
actions/
  utils.js                      # input check and error response helpers
  export-order/index.js         # order sync: I/O Events handler (Ep 1 skeleton at tag ep1-project-anatomy)
  export-order-retry/index.js   # order sync: scheduled retry
  order-sync/                   # mapper, ERP client, State bookkeeping, export logic
  stuck-orders/index.js         # Ep 3
app.config.yaml            # actions, trigger, rule
test/                      # Jest unit tests (mocked)
log/                       # developer-log write-ups, one per tag
```

Licence: Apache-2.0.
