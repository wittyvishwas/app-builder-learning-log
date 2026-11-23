# Agent hand-off: App Builder Ep 6, replace an observer with a Commerce event

Give this file to your coding agent (Claude Code or similar) inside your own App Builder project. It builds what Ep 6 built, in your project. Post: <https://mageminion.com/app-builder-ep6-commerce-events/>. Code: tag `ep6-commerce-events` in https://github.com/wittyvishwas/app-builder-learning-log.

Goal: a Runtime action that Adobe I/O Events calls for `observer.sales_order_place_after`. It sends the order to another system once, even when the same event arrives twice.

## Before you start
- Builds on Ep 1 (project layout, `.env` out of git), Ep 4 (Database Storage: `database.auto-provision`, the post-deploy hook `scripts/post-deploy-db-setup.js`, `include-ims-credentials`) and Ep 5 (logs, optional). Ep 6 stores its claims in Database Storage, so Ep 4 must already work in the project.
- The project is deployed to a Stage (non-Production) workspace.
- The human must have:
  - Adobe Developer Console access, `aio login` done, a non-Production workspace selected (`aio where`).
  - Adobe Commerce with eventing available. On PaaS: the eventing modules installed as [Adobe's installation guide](https://developer.adobe.com/commerce/extensibility/events/installation/) describes, and cron running. On Commerce as a Cloud Service: eventing is built in.
  - The workspace configuration downloaded from Developer Console as JSON.
  - An ERP (or other target) URL and key for the sender. The reference uses `ERP_API_URL` and `ERP_API_KEY`.
- Agent: stop and ask the human for anything in this list you can't confirm.

## Rules for the agent
- Never use a Production workspace. Never deploy without the human's yes.
- Before any `aio app deploy`, `aio app use` or onboarding script, run `aio where` and show the human the workspace. Continue only on their yes.
- Never write secret values to files under git; `.env` and `.aio` stay out of git. The workspace JSON holds credentials: never commit it, never paste it into a file in the repo.
- You can't reach Commerce. The Commerce admin and `bin/magento` steps are the human's.
- Build only what this file lists. Keep the reader's existing names and code style; rename the episode's names (listed below) to fit.
- Register one consumer only for the event. If your project already has a full order-export action registered for `observer.sales_order_place_after`, do not register both.

## Get the reference code
```bash
[ -d /tmp/abl ] || git clone https://github.com/wittyvishwas/app-builder-learning-log /tmp/abl
git -C /tmp/abl fetch --tags
# then, for each Files row: git -C /tmp/abl show REF:PATH
```
No row needs a later ref: `git log` shows no change after the tag to the Ep 6 files below (the later commits to `app.config.yaml` and `test/helpers.js` belong to other episodes).

## Files
| Path | Ref | What it is | Do |
|---|---|---|---|
| `actions/order-placed/index.js` | `ep6-commerce-events` | The handler. Reads the event, claims the order atomically in `order_claims`, sends it, writes the `sent` row in `export_runs`, marks the claim `sent`. Answers 200 when already sent, 503 while another delivery holds the claim, 500 on failure. | add |
| `actions/order-sync/erp.js` | `ep6-commerce-events` | `sendOrder`: POST to the ERP with the order number as `Idempotency-Key`, retries transient failures, a 409 counts as success. The handler's `sendToErp` calls it. | add, or replace with your own sender and keep the `sendToErp` seam |
| `scripts/post-deploy-db-setup.js` | `ep6-commerce-events` | The Ep 4 hook, now with the `order_claims` index. | merge into yours: add only the `order_claims` entry (below) |
| `test/order-placed.test.js` | `ep6-commerce-events` | Handler tests: claim won, duplicate, in-progress 503, failed send releases the claim, nested and flat payload, missing order number. | add |
| `test/helpers.js` | `ep6-commerce-events` | `fakeDb` (supports the claim's `$or`, `$lt`, upsert and unique index), `scriptedFetch`, `order`. | merge into yours |
| `test/fakedb.test.js` | `ep6-commerce-events` | Tests of `fakeDb`. Add if you copy `fakeDb`. | add |
| `test/db-setup.test.js` | `ep6-commerce-events` | Hook test, including the `order_claims` index. | merge into yours |

## Config
- `app.config.yaml`, a new package with the action. It is not a web action. It needs the workspace's OAuth credentials for Database Storage:
  ```yaml
  events:
    license: Apache-2.0
    actions:
      order-placed:
        function: actions/order-placed/index.js
        runtime: nodejs:20
        web: 'no'
        inputs:
          LOG_LEVEL: info
          ERP_API_URL: $ERP_API_URL
          ERP_API_KEY: $ERP_API_KEY
        annotations:
          include-ims-credentials: true
          final: true
  ```
- Post-deploy hook: add one collection to the `INDEXES` object in `scripts/post-deploy-db-setup.js`. One claim per order, unique on `order`:
  ```js
  order_claims: [
    { name: 'order_1', spec: { order: 1 }, options: { unique: true } }
  ],
  ```
  Do not put this index on `export_runs`. Ep 4 rows have no `order` field, and a unique index treats missing values as equal.
- `.env` keys, by name only: `ERP_API_URL` (base URL of the ERP; `/orders` is appended) and `ERP_API_KEY` (its key). The human provides both. Nothing else is new. The Ep 4 keys for the hook (`IMS_OAUTH_S2S_*`, `AIO_runtime_namespace`) must already be set.
- Human steps in Commerce, then Developer Console. The agent stops and asks the human to do these:
  1. Commerce admin, **Stores > Settings > Configuration > Adobe Services > Adobe I/O Events > General configuration**: paste the whole workspace JSON into **Adobe I/O Workspace Configuration**. Enter a unique **Adobe I/O Event Provider Instance ID** (letters, numbers, hyphens, underscores), for example `shop-stage`. Save. On Adobe Commerce on cloud infrastructure, also set `ENABLE_EVENTING: true` under `stage.global` in `.magento.env.yaml` and configure the cron consumers runner. Docs: <https://developer.adobe.com/commerce/extensibility/events/configure-commerce/>.
  2. Same section, **Create Event Provider** (label and description). On PaaS the CLI does the same, and the human pastes the ID it prints: `bin/magento events:create-event-provider --label "Shop Stage" --description "Commerce events from Stage"`. Then, under **Commerce events**, set **Enabled** to Yes, fill **Merchant ID** and **Environment ID** (together they become the event `source`), and click **Send Test Event**.
  3. Subscribe with only the fields needed (see [commands](https://developer.adobe.com/commerce/extensibility/events/commands/)). `--priority` sends at once instead of in the once-a-minute batch:
     ```bash
     bin/magento events:subscribe observer.sales_order_place_after \
       --fields=order.increment_id --fields=order.grand_total --priority
     bin/magento events:list
     ```
     Commerce as a Cloud Service: create the subscription in the admin under **System > Events**. Teams that keep config in code can declare it in a module's `io_events.xml`.
  4. Developer Console, Stage workspace: **Add service > Event > Commerce events**, pick the provider, tick `observer.sales_order_place_after`, choose the Runtime action `events/order-placed` as the destination. If "Commerce events" does not appear, run `bin/magento events:metadata:populate` or click **Execute Synchronization** in the admin.
- Field paths start from what the event carries. The order is under `order`, so the number is `order.increment_id`. A path that matches nothing is not an error: Commerce sends `{}`. Ask the human to check one real payload before trusting a field list.

## Tests
- Add `test/order-placed.test.js`, `test/fakedb.test.js` and the `fakeDb`, `scriptedFetch` and `order` exports from `test/helpers.js`. Merge the `order_claims` case from `test/db-setup.test.js`.
- The handler's tests need `actions/order-sync/erp.js` (or your own sender mocked) and `jest`.
- Run `npm test`. The fakes prove the logic, not the real service.

## Check it works
1. Local: `npm test` only. The handler needs Database Storage and I/O Events delivery. Under `aio app dev`, feeding it a saved order event wrote to the workspace's real database, so do that only with the human's yes.
2. On the non-Production workspace, after the human says yes to the deploy:
   1. `aio app deploy`, then `aio runtime action list` shows `events/order-placed`.
   2. The human places a test order on Stage.
   3. Developer Console, the registration's **Debug Tracing** tab. Runs started by I/O Events show up there, not in `aio rt activation list` or `aio app logs`.
   4. Look at the collection: `aio app db document find export_runs`. Expect one `sent` row for the order. Then `aio app db document find order_claims` and expect one `sent` claim for it.
   5. Optional: invoke the action twice at once by hand with the same made-up order. Expect one 200 and one 503, and one claim and one `sent` row.
   6. Run old and new paths side by side for a few days: point the old observer at a sandbox and compare what each sent. Only then does the human disable the observer.
- Retry facts, from Adobe's FAQ: I/O Events retries only 429 and 5xx answers (except 505), for up to 24 hours. A 409 ends retries, so a claim held by another delivery answers 503, not 409. The post saw a 503 from a scratch action retried three times (1, 2, 4 minutes), a 409 not retried. This handler has not yet had a real redelivery.
- Not verified in the post: a nested array path such as `order.items[].sku`, the exact error text of a unique-index violation on Adobe's service (the handler decides from the claim document, not the text), and a real redelivery to the handler.

## Names to rename
| In the reference | Why it may differ in yours |
|---|---|
| `events/order-placed` | Your package and action name. Developer Console must point at the same name. |
| `order_claims`, `export_runs` | Your collection names. The handler reads `export_runs` only to write the `sent` row; drop that write if you keep no such collection. |
| `region: 'emea'` in the handler | Must match the database region in your `app.config.yaml`. |
| `ERP_API_URL`, `ERP_API_KEY`, `sendToErp`, `sendOrder` | Your target system and its sender. Keep `sendToErp` as the one place that calls out. |
| `order.increment_id`, `order.grand_total` | The fields you subscribed. The handler needs only `order.increment_id`, matching `/^\S{1,64}$/`. |
| `shop-stage`, provider label, Merchant ID, Environment ID | Your own values. |

## Not in this episode
- Files present at this tag that belong to other episodes. Do not copy them:
  - `actions/cart-check/index.js`, `commerce/webhooks.xml`: webhooks (Ep 7).
  - `mesh/mesh.json`, `mesh/reviews-schema.json`: API Mesh (Ep 8).
  - `src/commerce-backend-ui-1/`: the Admin UI page and its actions (Ep 9), including `list-deliveries` and `retry-delivery` (Ep 10). This is the version 1 layout at this tag; on `main` the page is `src/commerce-backend-ui-2/` (Admin UI SDK version 2).
  - `actions/export-order/index.js`, `actions/export-order-retry/index.js`, `actions/order-sync/mapper.js`, `actions/order-sync/store.js`, `actions/order-sync/sync.js`: the full order sync with retry and dead rows (Ep 10, building on Ep 1 and 3). This episode's handler is the minimal one.
  - `actions/stuck-orders/index.js`, `actions/sync-log/index.js`: Ep 3 and Ep 4.
  - `actions/fake-erp/index.js`: a test ERP for real-workspace runs. It is public and deploys with every deploy. Not needed here.
- A New Relic dashboard and log forwarding setup: Ep 5.
