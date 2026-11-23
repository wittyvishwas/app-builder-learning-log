# Agent hand-off: App Builder Ep 10, port a small Adobe Commerce module to App Builder

Give this file to your coding agent (Claude Code or similar) inside your own App Builder project. It builds what Ep 10 built, in your project. Post: <https://mageminion.com/app-builder-ep10-port-a-module/>. Code: tag `ep10-port-a-module` in https://github.com/wittyvishwas/app-builder-learning-log.

## Before you start
- This is the capstone. It uses Ep 3 (alarm trigger and a State lock), Ep 4 (Database Storage and the `export_runs` collection), Ep 6 (the Commerce event subscription and the action that receives it) and Ep 9 (the Admin UI SDK page). Those must already exist in the project.
- The human must have a module to port: an observer on `sales_order_place_after` that calls an external API (for example an ERP), with its failure handling, config and admin status. The reference is a small stand-in module that POSTs each new order to an ERP, with a cron retry table.
- The human must have: Adobe Developer Console access, `aio login` done, and a non-Production workspace selected (check with `aio where`). A sandbox for the external API, not production.
- Agent: stop and ask the human for anything in this list you can't confirm.

## Rules for the agent
- Never use a Production workspace. Never deploy without the human's yes.
- Before any `aio app deploy`, `aio app use` or onboarding script, run `aio where` and show the human the workspace. Continue only on their yes.
- Never write secret values to files under git. `.env` and `.aio` stay out of git.
- Build only what this file lists. Keep the reader's existing names and code style; rename the episode's names (listed below) to fit.
- First write down what the module does: which event triggers it, what data it sends, what it does on failure, which config it reads, what it shows in the admin. That list is the acceptance test. Show it to the human before porting.
- Port the behaviour of the human's module, not the reference module's. If the human's module changes checkout totals, stop and say so: the post says that kind of module should stay a module.
- Point the app at a sandbox of the external API, never at production, until the human has compared both senders and says to switch.

## Get the reference code
```bash
[ -d /tmp/abl ] || git clone https://github.com/wittyvishwas/app-builder-learning-log /tmp/abl
git -C /tmp/abl fetch --tags
# then, for each Files row: git -C /tmp/abl show REF:PATH
```

## Files
Most rows are at the Ep 10 tag. The order-sync fixes (the `findOne` no-match fix and the sent-row fix) are already in that tag. The Admin UI rows (the page, the two admin actions and `ext.config.yaml`) are at `main`, because the Ep 9 hand-off now builds the page on Admin UI SDK version 2 (`src/commerce-backend-ui-2/`), and the `client_id` allowlist is part of those files (see the note under this table). The version 1 files are at the tag `ep10-port-a-module` (and `ep11-local-testing`) under `src/commerce-backend-ui-1/`; this hand-off no longer uses them.

| Path | Ref | What it is | Do |
|---|---|---|---|
| `actions/export-order/index.js` | `ep10-port-a-module` | The event handler. Reads the order from the `order` object of the event payload, sends it, records the outcome. A 2xx means handled (sent, skipped or queued); a 5xx makes I/O Events redeliver | add (adapt the mapping to your external API) |
| `actions/export-order-retry/index.js` | `ep10-port-a-module` | The scheduled retry run. One try per order per run, a State lock, a time budget | add |
| `actions/order-sync/sync.js` | `ep10-port-a-module` | Sends one order and records the result. 6 sends in total, then the row is `dead` | add |
| `actions/order-sync/store.js` | `ep10-port-a-module` | `export_runs` bookkeeping in Database Storage, the State lock, and `findOneOrNull` | add |
| `actions/order-sync/mapper.js` | `ep10-port-a-module` | Maps the Commerce order to the external API's shape (lines, shipping address) | add (rewrite for your API) |
| `actions/order-sync/erp.js` | `ep10-port-a-module` | The HTTP call: timeout, idempotency key, which statuses are transient | add (rewrite for your API) |
| `actions/utils.js` | `ep10-port-a-module` | Input check and error response helpers used by the actions | merge into yours |
| `scripts/post-deploy-db-setup.js` | `ep10-port-a-module` | The post-deploy hook that creates the database indexes, including the ones `export_runs` needs | merge only the `export_runs` index entries; the `order_claims` (Ep 6) and `stuck_alerts` (Ep 9) entries come from those hand-offs |
| `app.config.yaml` | `ep10-port-a-module` | Root config: `export-order` and `export-order-retry` (the 10-minute alarm trigger and rule), the post-deploy hook, `include-ims-credentials: true` on the actions that use the database | merge into yours (those entries only) |
| `src/commerce-backend-ui-2/ext.config.yaml` | `main` | Extension config (Admin UI SDK version 2); adds the `list-deliveries` and `retry-delivery` web actions next to the Ep 9 ones | merge into yours (add the two actions) |
| `src/commerce-backend-ui-2/actions/list-deliveries/index.js` | `main` | Returns recent deliveries and failures from `export_runs` for the admin page | add |
| `src/commerce-backend-ui-2/actions/retry-delivery/index.js` | `main` | The Retry button's action: for a `dead` row, fetches the order again from Commerce and resends it | add |
| `src/commerce-backend-ui-2/web-src/src/pages/main-page.tsx` | `main` | The Ep 9 page (React Spectrum 2, loaded by `createExtensionApp`), now with the Stuck orders and Deliveries tabs. The Deliveries tab is a table with a Retry button; its component file sits next to the page under `web-src/src/`, take its name from the `main` tree | merge into yours (add the tab) |
| `commerce/OrderExport` | `ep10-port-a-module` | The stand-in PHP module (observer, retry cron, retry table, config) that the run ported. Comparison aid only | read only |
| `scripts/compare-erp.js` | `ep10-port-a-module` | Prints what the app and the module each sent to the fake ERP, per order. Only for the side-by-side run | read only (optional) |
| `actions/fake-erp/index.js` | `ep10-port-a-module` | A fake ERP as a public web action, so the side-by-side run has something to send to. Test helper | read only (optional, never deploy to Production) |

Later-fix decisions: `list-deliveries/index.js`, `retry-delivery/index.js` and `ext.config.yaml` at `main` carry the Ep 9 `client_id` allowlist (`checkClient` at the top of `main`, an `ALLOWED_CLIENT_IDS` input). The Ep 9 hand-off always installs that allowlist, so take these files from `main`. Never remove the check to make a test pass: `retry-delivery` resends orders to the external API, and without the allowlist only `require-adobe-auth` guards it.

## Config
- `app.config.yaml` (from the tag):
  - `export-order`: `web: 'no'`, inputs `ERP_API_URL` and `ERP_API_KEY`, `include-ims-credentials: true`, `final: true`.
  - `export-order-retry`: same inputs, a 300000 ms timeout (below the 10-minute alarm period), a trigger with cron `*/10 * * * *` and a rule that runs it.
  - Register the event with only one consumer. The Ep 6 `order-placed` action and `export-order` both handle `sales_order_place_after`: `export-order` is the full version, so register only it.
- `src/commerce-backend-ui-2/ext.config.yaml`: `list-deliveries` and `retry-delivery` are web actions with `require-adobe-auth: true`, `include-ims-credentials: true` and `final: true`. `retry-delivery` also takes `COMMERCE_BASE_URL` and `COMMERCE_TOKEN`, because a dead row keeps no order and Retry fetches it again from Commerce.
- `.env` keys (names only; the human provides the values):
  - `ERP_API_URL`, `ERP_API_KEY`: the external API's base URL and key (a sandbox).
  - `COMMERCE_BASE_URL`, `COMMERCE_TOKEN`: for `retry-delivery`, as in Ep 3.
  - `ALLOWED_CLIENT_IDS`: required, already set by Ep 9. The two new actions read it too; empty refuses every call.
  - `IMS_OAUTH_S2S_CLIENT_ID`, `IMS_OAUTH_S2S_CLIENT_SECRET`, `IMS_OAUTH_S2S_ORG_ID`, `IMS_OAUTH_S2S_SCOPES`: for the post-deploy hook. `aio app use` writes `AIO_runtime_namespace`; do not add a second spelling.
  - `FAKE_ERP_API_KEY`: only if the human uses the fake ERP helper. At least 16 characters.
- The Commerce event subscription is a human step on the Commerce server. The agent stops and asks the human to run it. The post's command (the fields start with `order.` because the order sits under `order` in this event):
```bash
bin/magento events:subscribe observer.sales_order_place_after \
  --fields=order.increment_id --fields=order.items --fields=order.addresses
```
  - `--fields=order.items` sends every field of every item. Once you know which ones the API reads, list just those with `order.items[].sku` notation (<https://developer.adobe.com/commerce/extensibility/events/module-development>).
  - A path that matches nothing is dropped without an error. One test case in the run: `order.shipping_address` arrived as null because the order data has no such key. The addresses are under `order.addresses`, and the mapper picks the shipping one from there.
  - If the project has two event providers, add `--providerId` with the one your registration listens on. Without it the subscription goes to the default provider and the app never sees the event.
- API keys move from Commerce config to the action's environment, injected at deploy time. Never copy the module's stored keys into a file under git.
- Keep every call idempotent, with the order number as the key.
- The `aio-lib-db` 1.1.0 trap: `findOne` does not return `null` when nothing matches. It throws a `DbError` ("Document not found"), so the first lookup for a new order made the action answer 500 (I/O Events redelivers a 500). `findOneOrNull` in `actions/order-sync/store.js` treats exactly that error as `null` and rethrows the rest, so a real outage is not hidden. Use it for every `findOne`.

## Tests
- Add from `test/` at `ep10-port-a-module`: `export-order.test.js`, `mapper.test.js`, `erp.test.js`, `fakedb.test.js`, `registration.test.js`. In `db-setup.test.js`, add only the `export_runs` cases; keep the Ep 6 and Ep 9 cases already there.
- Add `list-deliveries.test.js` and `retry-delivery.test.js` from `ep11-local-testing` (they test the allowlist too).
- `test/helpers.js`: merge, never replace. Your copy from Ep 9 (`ep11-local-testing`) already has the fake database (its `findOne` throws on no match, like the real library), the fake State, a scripted `fetch`, and `tokenFor` and `authed`, which the Ep 9 tests import. The Ep 10 copy lacks the last two.
- Optional, only with the comparison scripts: `compare-erp.test.js` and `fake-erp.test.js`.
- The mapper and ERP tests encode the reference API's shape. Rewrite them for your API; keep the cases (nested `order`, addresses under `order.addresses`, skip children of configurable products, idempotent resend, transient vs permanent errors).
- Run `npm test`.

## Check it works
1. Local first. `npm test`. Optional, only with the human's yes: feed a saved event payload to `export-order` under `aio app dev`, with `ERP_API_URL` set in the shell to a sandbox or fake ERP (never the real one). It writes rows to the workspace's real Database Storage and POSTs to that URL. Run `dev/run-ep11/guard.sh` first if the project has it (Ep 11), and delete your test rows afterwards. Per the Ep 11 grid, no alarm triggers run locally, so call the retry action by hand.
2. Then deployed to the non-Production workspace, after the human says yes (after `aio where` is shown). Use the post's checks:
   - Place one test order and read the payload before go-live: the order lines and the shipping address must match what the module sent.
   - The `export_runs` collection records the `sent` rows. The retry alarm runs every 10 minutes.
   - Failure test: with the external API address broken, the order is queued (a `retry` row) and delivered from the retry run once the address is restored.
   - Side by side: the human runs the old module and the app against the same sandbox for a few days and compares what each sent. The module sends inside checkout; the app sends after it (in the post's run, 9.1 s later on a normal order).
   - Switch-over, only after both match and the human says yes: disable the module's observer, then point the app at the external API's production URL. A new order must reach the API from the app only. Deploying to a Production App Builder workspace is outside this hand-off.
3. Shared staging: the app exports every order, because it has no test filter. Filter on your side, or use a staging of your own.
- Proven in the post: the handler received real orders as the only consumer of `sales_order_place_after`, with `order.items` and `order.addresses`; the 10-minute retry ran; `export_runs` recorded `sent`; payloads matched the module; the failure test queued and delivered the order in both senders; after the module was disabled only the app sent. Not proven: the `dead` state when retries run out, the admin Retry button, extension packaging.

## Names to rename
| In the reference | Why it may differ in yours |
|---|---|
| `order-sync` (package), `export-order`, `export-order-retry` | Your package and action names |
| `export_runs` (collection) | Your collection name; it is the Ep 4 collection |
| `ERP_API_URL`, `ERP_API_KEY` | Your external API's name |
| `mapper.js`, `erp.js` | The mapping and the HTTP call belong to your API |
| `Deliveries`, `list-deliveries`, `retry-delivery` | Your page and action names |
| `every10Minutes`, `orderSyncRetrySchedule` | Your trigger and rule names, and your retry period |

## Not in this episode
- `actions/order-placed` (the Ep 6 handler), `actions/cart-check` and `commerce/webhooks.xml` (Ep 7), `commerce/CartCheck` (Ep 7 run kit), `mesh/` (Ep 8): present at this tag. Do not copy them.
- `actions/stuck-orders` and `StuckAlerts.js`: Ep 3 and Ep 9. The `client_id` allowlist (`allowed-client.js`) and the non-JSON fix in `utils.js`: Ep 9.
- `dev/run-ep7/` and `dev/run-ep10/`: run notes and scratch files, not part of the build.
- The Playwright regression suite the post mentions is not in this repo.
