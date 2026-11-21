# Ep 11 run: what runs on your machine, what needs a deploy

Run date: 2026-11-21. Stage test workspace (the Ep 8–10 one), a local Adobe Commerce (PaaS, Warden).

## Versions

- aio-cli 11.2.0, api-mesh plugin 5.7.2, Node 24.21.0
- `npm test`: 334 passed at the start, 389 after the Ep 11 probe and journal-pull tests
- Local Commerce: Admin UI SDK, Commerce eventing and webhooks modules enabled

## Baseline (for the undo checks)

- `aio where` (global) shows a different project than the repo's `.aio`. Every `aio` command in this run is run inside the repo; `aio event registration list` there lists the repo workspace.
- `stuckOrdersSchedule`: inactive
- `aio rt action get ops/stuck-orders | sha256sum`: `918457b6988c87ba…`
- Event registrations in the workspace: 8
- Runtime actions in the namespace: 30

## Undo log

(one line per change: what, original value, restored, check command and result)

- Task 4 wskdebug on `ops/stuck-orders`: the agent replaced the action and stayed behind after run 1 died. The backup action `ops/stuck-orders_wskdebug_original` was deleted by mistake before the annotations were checked, so wskdebug could not restore it (run 2: "Agent is already installed and action backup is missing"). An update with the saved original code left the agent annotations (`description`, `wskdebug=true`, `provide-api-key=true`): Runtime merges annotations on update. Restored by delete + create from the code saved before the run (`--save-as`) and the current params. Check: annotations equal the baseline six (`web-export=false`, `whisk-managed`, `final=true`, `exec`, `include-ims-credentials=true`, `raw-http=false`), code sha256 `3407862959f8bf36…` = baseline, 8 params, limits unchanged, 0 `*wskdebug*` actions, no wskdebug container, rule inactive.

## Results

(one line per probe: `RUN: works`, `RUN: fails (<message>)` or `DOCS ONLY (<why>)`, and where it ran: local Node, Runtime, wskdebug container)

### Task 1: actions under `aio app dev` (local Node)

- `aio app dev` with no flag: RUN: fails ("Your app implements multiple extensions. You can only run one at the time, please select which extension to run with the '-e' flag"). The app has `application` and `commerce/backend-ui/1`.
- `aio app dev -e application`: RUN: works. Generated a self-signed certificate, served on `https://localhost:9080`, listed 4 web and 5 non-web actions, watches `actions/`.
- Public web action `dev/fake-erp` without `Authorization`: RUN: works, 401 `{"error":"unauthorized"}` (the action's own key check).
- `dev/fake-erp` GET with the key, unknown order: RUN: works, 404 `{"error":"not found"}`. The action reads State for this; a State failure would answer 503. First sign that State answers under `aio app dev` (confirm with the probe, Task 2).
- `require-adobe-auth` action (`dev/ep11-probe`) with no headers: RUN: works, 401 `cannot authorize request, reason: missing authorization header`.
- Same action with `Authorization: Bearer dummy` and `x-gw-ims-org-id: dummy`: RUN: passes the check (400 from the action for an unknown op). Locally only the presence of the headers is checked, not the token.
- Non-web action `ops/stuck-orders` over HTTP: RUN: served, with the warning "serving non-web action : this call will fail without credentials when deployed"; answered 500 because `COMMERCE_BASE_URL` is not set (as on Stage, README Ep 3).
- No activation records for local calls (docs; not re-checked).

- Start the run with the probe gated on: `EP11_PROBE_ENABLED=1 aio app dev -e application` (set it in that shell only, never in `.env`). Without it the ep11-probe action answers 403 `{"error":"ep11-probe disabled"}`.
- ep11-probe is now a non-web action (`web: 'no'`, no `require-adobe-auth`/`final`; commit "ep11: probe is a non-web action (deploy-safe), pass __ims_env"). Local call under `aio app dev -e application`: `https://localhost:9080/api/v1/web/dev/ep11-probe?op=state|files|db` (`/api/v1/dev/ep11-probe` also works; served with the "serving non-web action" warning, no auth headers needed). Task 9 undo check: `aio rt action list` on Stage shows neither `ep11-probe` nor `__secured_ep11-probe`.

## Probe live (2026-11-21, aio app dev -e application with EP11_PROBE_ENABLED=1; guard.sh OK before each run)

| Service | (a) plain Node script, .env namespace creds | (b) ep11-probe under `aio app dev` |
|---|---|---|
| State (aio-lib-state) | RUN: init, put, get, delete ok | RUN: init, put, get, delete ok (HTTP 200) |
| Files (aio-lib-files) | RUN, fails: write -> `FilesLib:ERROR_BAD_CREDENTIALS` "...executed from Adobe I/O Runtime" (init ok) | RUN, fails: same error |
| Database Storage (aio-lib-db) | RUN: token, init, insertOne, findOne, deleteOne, drop ok | RUN: same, all ok (writes to the Stage workspace DB; collection dropped) |

State answers from localhost in both setups, which contradicts Adobe's troubleshooting page (State and Files "localhost is not authorized"); Files matches the page.
Locally a query param does not override the action's inputs (`?EP11_PROBE_ENABLED=0` still ran).

## Commerce events (2026-11-21)

- RUN (local): the saved `observer.sales_order_place_after` payload (made-up order EP11-TEST-0001, CloudEvent shape, order under `data.value.order`) POSTed to `events/order-placed` under `aio app dev` with `ERP_API_URL` set in the process env to a dead local port (process env beats `.env` in aio-lib-core-config). Answer 500 "ERP unreachable: fetch failed"; `order_claims` got one `failed` row in the Stage DB (the handler's DB is the workspace's real one); a redelivery claimed it again and failed the same way. A payload without an order number answers 400. Rows deleted afterwards (0/0).
- RUN (Local + Stage): a temporary journal registration (one Commerce order event) created on the Stage workspace, `journal-pull.js --order EP11-TEST-0001 --dry-run` read it: token, headers and journal call ok, 0 events (no order was placed: owner decision). Registration deleted by id; registration ids equal the baseline (8). JOURNAL_URL was added to `.env` for the run and removed.
- DOCS ONLY: a live order through I/O Events delivery and retries.

## Cron (2026-11-21)

- Local: `aio app dev` has no trigger or alarm handling (its `run-dev.js` has no trigger, feed or alarm code); the cron action is called by hand over HTTP (Task 1 row for `ops/stuck-orders`).
- RUN, fails (Local + Stage): `wskdebug ops/stuck-orders` (wskdebug 1.x, image `adobeapiplatform/adobe-action-nodejs-v20`) installed its agent, then the agent polling got 502 from I/O Runtime ("An error has occurred: [object Object]") and the run ended. Lesson: before a retry, keep the `<action>_wskdebug_original` backup; when an agent is left behind, `wskdebug --cleanup` (not a hand delete) restores it. Undo above.
- RUN (Deploy only): `stuckOrdersSchedule` enabled at 17:13 UTC, disabled at 17:23 (rule inactive again, `orderSyncRetrySchedule` untouched and inactive). The `every15Minutes` trigger fired at 17:15:02; `ops/stuck-orders` ran at 17:15:11 (9.2 s wait, 0.9 s cold init, 1.1 s run, status success). The alarm firing is the one thing only a deploy shows. (Filtering `activation list` by the bare name `stuck-orders` returned nothing; the unfiltered list shows it.)

## Webhooks (2026-11-21)

- Setup (local Commerce, developer mode, no webhooks before): the repo's `commerce/CartCheck` module copied in with `sslVerification="false"` added to the hook (copy only), `module:enable`; signing switched on with a new key pair (same code as the admin "Generate Keys" button) and "Validate Webhook Destinations" = No, for the run only. `aio app dev -e application` with `PUBLIC_KEY` set to that public key in the process env (no `.env` edit). Commerce reaches it at `https://host.docker.internal:9080` from the PHP container.
- RUN, fails (Local): `webhooks:dev:run observer.sales_quote_add_item:before` with `MMTEST-RESTRICTED-1` and `MMTEST-OK-1`: the local action answered `exception` for both ("request has no signature or no body"). Cause, from the aio-cli-plugin-app-dev source (`run-dev.js`, `isRawWebAction`): it treats an action as raw only for `web: 'raw'` (or `web-export: raw`); the `raw-http: true` annotation that `cart-check` uses is ignored, so the JSON body is parsed into params and `__ow_body` is missing. A `raw-http` webhook with a signature check can't be tested under `aio app dev` as deployed. (Not worked around.)
- RUN (Local + Stage): the same `dev:run` against the deployed `webhooks/cart-check`: first call timed out at the hook's 2000 ms (cold start), the second answered `exception` in 0.7 s (over the 500 ms soft timeout). Expected refusal: the local signing key is not the one in the deployed `PUBLIC_KEY`. The deployed signature path itself is proven in Ep 7 (Stage).
- Undo: module disabled, `app/etc/config.php` restored (sha = baseline), the four `commerce_webhooks/*` rows deleted (0 left), cache flushed; `git status --short` and `webhooks:list` (empty) equal the baseline.

## Grid (what this run showed)

| Piece (episode) | Local | Local + Stage | Deploy only |
|---|---|---|---|
| Unit tests (all) | RUN: `npm test` (fakes) | – | – |
| Web actions, `require-adobe-auth` (1, 2, 9) | RUN: `aio app dev -e <ext>`; auth = header presence only | proven in Ep 9 (deployed sequence, 401/200) | the validator sequence |
| State (3) | RUN: works under `aio app dev` and from a script | RUN: script with namespace creds | – |
| Files (3) | RUN, fails: `ERROR_BAD_CREDENTIALS` | RUN, fails: same | Files from Runtime |
| Database Storage (4, 10) | RUN: works under `aio app dev` (real workspace DB) | RUN: script | post-deploy index hook (Ep 4) |
| Cron (3, 10) | call the action by hand; no triggers under `aio app dev` | RUN, fails: wskdebug (502) | RUN: alarm fired the action |
| Log forwarding (5) | terminal logs | `aio app logs` (Ep 5) | forwarding (Ep 5) |
| Commerce events (6, 10) | RUN: saved payload to the handler | RUN: journaling dry run, 0 events | DOCS ONLY: I/O Events delivery, retries (retries measured in Ep 6) |
| Webhooks (7) | RUN, fails: `raw-http` ignored by `aio app dev` | RUN: local Commerce → deployed action (refused: different key) | signed path (Ep 7) |
| API Mesh (8) | RUN: `aio api-mesh run`, batching, no cache | sources = deployed actions (same run) | edge cache (Ep 8) |
| Admin UI (9) | RUN: menu from `aio app dev` via a registry stand-in; page not opened | proven in Ep 9 | – |
