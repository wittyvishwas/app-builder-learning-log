# Agent hand-off: App Builder Ep 11, what runs on your machine and what needs a deploy

Give this file to your coding agent (Claude Code or similar) inside your own App Builder project. It builds what Ep 11 built, in your project: a small local test harness, and the grid that says which checks your machine can answer before you deploy. Post: <https://mageminion.com/app-builder-ep11-local-testing/>. Code: tag `ep11-local-testing` in https://github.com/wittyvishwas/app-builder-learning-log.

## Before you start
- This tests the app from Ep 1 to Ep 10. It needs the project's actions, `.env`, and the Ep 4 post-deploy hook script (`scripts/post-deploy-db-setup.js`, which exports `parseScopes`).
- The human must have: Adobe Developer Console access, `aio login` done, and a non-Production workspace selected (check with `aio where`). The post used aio CLI 11.2.0.
- For the webhook and Admin UI rows of the grid: a local Adobe Commerce (PaaS) with the eventing, webhooks and Admin UI SDK modules. Without it, skip those rows.
- Agent: stop and ask the human for anything in this list you can't confirm.

## Rules for the agent
- Never use a Production workspace. Never deploy without the human's yes.
- Before any `aio app deploy`, `aio app use` or onboarding script, run `aio where` and show the human the workspace. Continue only on their yes.
- Before any command that changes something (`aio app dev`, `aio event ...`, `aio api-mesh ...`, a database write), run `dev/run-ep11/guard.sh && <command>`. It refuses unless the project, workspace and Runtime namespace match `.env`.
- Never write secret values to files under git. `.env` and `.aio` stay out of git. Never print `.env` values.
- Build only what this file lists. Keep the reader's existing names and code style; rename the episode's names (listed below) to fit.
- Do not change production code to make a local test pass. The signed webhook cannot pass its signature check under `aio app dev`; leave `cart-check` alone.
- Do not use `wskdebug` on I/O Runtime. It failed twice in the post and left the deployed action changed (see Check it works).
- `aio app dev` writes to the workspace's real database. Delete every test row you create.
- The `ep11-probe` action is a test helper. Never set `EP11_PROBE_ENABLED` in `.env`. Set it only in the shell that starts `aio app dev`. Do not remove the entry from `app.config.yaml` on your own (see Config).

## Get the reference code
```bash
[ -d /tmp/abl ] || git clone https://github.com/wittyvishwas/app-builder-learning-log /tmp/abl
git -C /tmp/abl fetch --tags
# then, for each Files row: git -C /tmp/abl show REF:PATH
```

## Files
All rows are at the Ep 11 tag. Nothing in this episode has a later fix.

| Path | Ref | What it is | Do |
|---|---|---|---|
| `dev/run-ep11/guard.sh` | `ep11-local-testing` | Workspace guard. Exits non-zero unless `aio where` shows the expected project and workspace and the Runtime namespace list (a server call) contains the namespace in `.env`. Reads only `.env`, never the shell environment, and prints no values | add |
| `dev/run-ep11/state-probe.js` | `ep11-local-testing` | Runs the State and Files calls from plain Node (`--db`: Database Storage insert, find, delete, drop on collection `ep11_probe`). One line per call: library, call, ok or error. Masks `.env` values of 8 or more characters | add |
| `dev/run-ep11/journal-pull.js` | `ep11-local-testing` | Reads events from an I/O Events journaling endpoint. Dry run by default, one order only. With `--post` it posts one matching event to a local handler (localhost addresses only) | add |
| `actions/ep11-probe/index.js` | `ep11-local-testing` | The probe as a non-web action, run under `aio app dev` with `?op=state`, `files` or `db`. Answers 403 unless `EP11_PROBE_ENABLED` is `1`. Non-web (see Config) | add |
| `actions/ep11-probe/probe.js` | `ep11-local-testing` | The State, Files and database calls, shared by the action and by `state-probe.js`. Random suffix on keys, cleans up after itself | add |
| `dev/run-ep8/env.js` | `ep11-local-testing` | `.env` reader (`loadEnv`, `need`) that both scripts use. It comes from the Ep 8 run kit | add |
| `scripts/post-deploy-db-setup.js` | `ep11-local-testing` | The Ep 4 hook; `state-probe.js` imports `parseScopes` from it. Needs that export | merge into yours (only if it lacks `parseScopes`) |
| `app.config.yaml` | `ep11-local-testing` | Root config: only the `ep11-probe` action entry (quoted under Config) | merge into yours (that entry only) |
| `test/ep11-probe.test.js` | `ep11-local-testing` | Tests for the probe action, `state-probe.js`, and the `ep11-probe` manifest entry (non-web, no `require-adobe-auth`, no `final`) | add |
| `test/journal-pull.test.js` | `ep11-local-testing` | Tests for `journal-pull.js` (arguments, paging, local-only `--post`, no secrets printed) | add |
| `test/helpers.js` | `ep11-local-testing` | Fakes the tests need: `fakeState`, `fakeDb`, `DbError`, `scriptedFetch` | merge into yours |

Not copied on purpose: `dev/run-ep11/undo-task8.log` and `dev/run-ep11/README.md` are run artefacts of the post's session, not part of the harness.

## Config
- `app.config.yaml`, the `ep11-probe` entry, in your application's actions (non-web on purpose: deployed, only a caller with the namespace auth can invoke it; a web action with `require-adobe-auth` would become a web sequence where request params override the inputs, `EP11_PROBE_ENABLED` included):
```yaml
dev:
  license: Apache-2.0
  actions:
    ep11-probe:
      function: actions/ep11-probe/index.js
      runtime: nodejs:20
      web: 'no'
      inputs:
        LOG_LEVEL: info
        EP11_PROBE_ENABLED: $EP11_PROBE_ENABLED
      annotations:
        include-ims-credentials: true
```
- The entry goes in a package named `dev` (the reference's `dev` package also holds the Ep 10 `fake-erp` helper; if you have that package, add the entry to it). It deploys with every `aio app deploy`, like the reference. That is acceptable for two reasons. It is non-web, so a deployed copy can only be invoked with the namespace auth. And it answers 403 unless `EP11_PROBE_ENABLED` is `'1'`, which `.env` must never set. Caveat from the action's header: an invoker can pass that input as a parameter, so the gate alone is no protection. It is acceptable only because anyone with the namespace auth already has full access to the namespace. Locally it is served at `https://localhost:9080/api/v1/web/dev/ep11-probe?op=...`.
- Ask the human once whether to keep the entry in the manifest. If they want it out, remove the entry and its manifest test in `test/ep11-probe.test.js` together (the test named for `app.config.yaml`), never one without the other.
- `.env` keys (names only; the human provides the values):
  - `AIO_runtime_namespace`, `AIO_runtime_auth`: written by `aio app use`. `state-probe.js` needs both for State and Files.
  - `IMS_OAUTH_S2S_CLIENT_ID`, `IMS_OAUTH_S2S_CLIENT_SECRET`, `IMS_OAUTH_S2S_ORG_ID`, `IMS_OAUTH_S2S_SCOPES`: the OAuth server-to-server credential the workspace already uses. `state-probe.js --db` and `journal-pull.js` need them.
  - `MESH_PROJECT_TITLE`, `MESH_WORKSPACE_NAME`: the exact Developer Console project title and workspace name. `guard.sh` needs both and refuses if either is blank. `MESH_WORKSPACE_NAME` must name a non-Production workspace: the guard only checks that `aio where` matches `.env`, not that the workspace is safe.
  - `JOURNAL_URL`: the journaling endpoint of the registration. `JOURNAL_API_KEY` is optional: it overrides the x-api-key when it is not the client id.
  - `ERP_API_URL`, `COMMERCE_BASE_URL`: used as in earlier episodes. A process variable beats `.env`, so you can point one run at another value without editing `.env`.
- Shell only, never `.env`: `EP11_PROBE_ENABLED=1`, in the shell that starts `aio app dev`.
- Human steps. The agent stops and asks the human:
  - Create a journaling registration on the Stage workspace and give you its journaling URL as `JOURNAL_URL`. The post doesn't link a page for this step. The I/O Management API must be added to the workspace, or the journal answers 403. Delete the registration afterwards.
  - Place a test order in the local Commerce, if the human wants a real event in the journal (the post's dry run read 0 events because no order was placed).
  - For the webhook row: run the local Commerce's `webhooks:dev:run` (<https://developer.adobe.com/commerce/extensibility/webhooks/testing/>). The Admin UI row uses the Admin UI SDK's local testing (<https://developer.adobe.com/commerce/extensibility/admin-ui-sdk/configuration/>), PaaS only.

## Tests
- Add `test/ep11-probe.test.js` and `test/journal-pull.test.js`, with `test/helpers.js`. They fake everything external.
- `test/ep11-probe.test.js` reads `app.config.yaml` at the repo root and looks for the `ep11-probe` entry by its indentation. If your file is indented differently, fix the test's slice, not the check.
- Run `npm test`.

## Check it works
How to read the post's grid. Rows are pieces of the app. The columns say where you can test each piece: on your machine, as local code against the Stage services, and only after a deploy. In a cell, RUN means the post ran it in that session. "Ep N" means an earlier episode proved it and the post did not repeat it. DOCS ONLY means nobody ran it. On Adobe Commerce as a Cloud Service two cells change: test webhooks in the Admin, not with `webhooks:dev:run`, and Admin UI SDK local testing is PaaS only.

| Piece | On your machine | Your code, Stage services | Only a deploy shows |
|---|---|---|---|
| Unit tests | RUN: `npm test` (fakes) | – | – |
| Web actions, `require-adobe-auth` | RUN: `aio app dev`; the auth check only looks for the headers | Ep 9: the deployed sequence answers 401 without a token | the validator sequence |
| State | RUN: works, against the docs | RUN: script with the namespace credentials | – |
| Files | RUN, fails: `ERROR_BAD_CREDENTIALS` | RUN, fails: same | Files from Runtime |
| Database Storage | RUN: works, on the workspace's real database | RUN: script | the post-deploy index hook (Ep 4) |
| Cron | call the action by hand; no triggers under `aio app dev` | RUN, fails: `wskdebug` | RUN: the alarm fired the action |
| Log forwarding | logs in the terminal | `aio app logs` (Ep 5) | forwarding (Ep 5) |
| Commerce events | RUN: a saved payload to the handler | RUN: a journaling pull, dry run | DOCS ONLY: delivery; retries measured in Ep 6 |
| Webhooks | RUN, fails: `raw-http` ignored | RUN, refused: `webhooks:dev:run` to the deployed action (likely the key) | the signed path (Ep 7) |
| API Mesh | RUN: `aio api-mesh run`, one batched call | sources are the deployed actions | the edge cache (Ep 8) |
| Admin UI SDK | RUN: the menu from `aio app dev` through local testing; page not opened | Ep 9 | – |

Local steps, in this order. Run `dev/run-ep11/guard.sh` first for each command that changes something.
1. Unit tests: `npm test`.
2. Actions under `aio app dev`. It runs one extension at a time and this app has two, so plain `aio app dev` stops with "You can only run one at the time, please select which extension to run with the '-e' flag". Use `aio app dev -e application` (actions on https://localhost:9080, self-signed certificate) and `aio app dev -e commerce/backend-ui/1` for the Admin UI extension. What to expect:
   - `require-adobe-auth` is a header check: no headers gives 401; any `Authorization: Bearer ...` plus any `x-gw-ims-org-id` passes. The deployed sequence checks the token; the local one doesn't.
   - Non-web actions are served too, with a warning. The cron action called over HTTP without `COMMERCE_BASE_URL` answers 500, as on Stage.
   - A process variable beats `.env`: `ERP_API_URL=<dead address> aio app dev -e application` points the order handler elsewhere without touching `.env`. A query parameter does not override an action input.
   - Database Storage writes to Stage. A saved order event sent to `events/order-placed` leaves a real `failed` claim row. Delete your test rows.
3. State, Files and the database from Node: `node dev/run-ep11/state-probe.js` (State and Files), `node dev/run-ep11/state-probe.js --db` (Database Storage; it writes, so run the guard first). Expect State ok, Files `ERROR_BAD_CREDENTIALS`, database ok. The same calls run inside an action with `EP11_PROBE_ENABLED=1 aio app dev -e application`, then `?op=state`, `?op=files` or `?op=db` on the action's local URL.
4. Events: `node dev/run-ep11/journal-pull.js --order <increment_id>` is a dry run: it lists only. To send one event to the local handler: `node dev/run-ep11/journal-pull.js --order <increment_id> --post https://localhost:9080/api/v1/web/events/order-placed` (`--post` accepts only this machine's addresses). Delete the registration afterwards.
5. Webhooks: do not try to fix this locally. `aio app dev` ignores `raw-http: true`: it treats an action as raw only when it says `web: 'raw'`. So the body is parsed into params, `__ow_body` is missing, and `cart-check` refuses every call from Commerce. The local Commerce reached the local action through `https://host.docker.internal:9080` with `sslVerification="false"` on the hook. Against the deployed `cart-check` the first call timed out at the hook's 2000 ms (cold start) and the second was refused, likely because the local signing key is not the deployed `PUBLIC_KEY`.
6. API Mesh: `aio api-mesh:init` (the first `npm install` took about 10 minutes), then `aio api-mesh run mesh.json --port 9000`. Expect one batched reviews call with all the SKUs. The post's run couldn't say whether the local server caches: the edge cache stays a deploy-only check. After Ctrl+C the mesh's worker processes may still hold the port: stop them by hand.
7. Admin UI SDK local testing replaces Adobe's App Registry: "Local Server Base URL" must point at something that answers like the registry (Adobe's sample is a small `server.js`). Only the registry call turns off SSL verification, and the `aio app dev` certificate is self-signed.

Deployed, only after the human says yes (after `aio where` is shown): the checks only a deploy shows. In the post: the alarm rule `stuckOrdersSchedule` was enabled for ten minutes, the `every15Minutes` trigger fired at the quarter hour and `ops/stuck-orders` ran 9 seconds later, then the rule was disabled again. A real I/O Events delivery with its retries, the signed webhook, the mesh's edge cache and the validator sequence in front of `require-adobe-auth` actions are the other deploy-only checks. Everything in the first two columns is tried before a deploy.

If the human tries `wskdebug` anyway, save the action first and check its annotations afterwards. It swapped the deployed action for an agent and failed on I/O Runtime twice (version 1.4.0 got a 502 from its own polling; version 1.2.0 died on the first invoke). Both times annotations stayed on the action, including `provide-api-key=true`, which hands the namespace key to the action. Updating with the original code does not remove them, because Runtime merges annotations on update. Both times the post deleted the action and created it again from the saved copy. Adobe's page also says `wskdebug` can't be used with `aio-lib-state` or `aio-lib-files`:
```bash
aio rt action get ops/stuck-orders --save-as before.zip
aio rt action get ops/stuck-orders | grep -A2 -E 'wskdebug|provide-api-key'
```
- Proven in the post (one session, 21 Nov 2026, aio-cli 11.2.0, a local Commerce in developer mode, the Ep 8 to 10 Stage workspace): every Stage change was undone and checked. Not run: a live order through I/O Events to a local handler, the Admin UI page in the admin iframe, the signed webhook under `aio app dev`, the mesh cache with a cacheable source.

## Names to rename
| In the reference | Why it may differ in yours |
|---|---|
| `ops/stuck-orders`, `events/order-placed`, `webhooks/cart-check` | Your package and action names |
| `-e application`, `-e commerce/backend-ui/1` | Your extension names; run `aio app dev` once without `-e` to see them in the error |
| `ep11_probe` (collection), `ep11/probe.txt` (Files path) | The probe's own names; any name works |
| `stuckOrdersSchedule`, `every15Minutes` | Your rule and trigger names |
| `MESH_PROJECT_TITLE`, `MESH_WORKSPACE_NAME` | The names the guard expects; they come from the Ep 8 run kit |
| `emea` (database region in `probe.js`) | Must match the region in your `app.config.yaml` |

## Not in this episode
- The code under test: Ep 1 to Ep 10. This episode adds a harness, not features.
- `dev/run-ep8/` other than `env.js` (fake reviews source, mesh scripts), `actions/fake-reviews`, `actions/fake-erp`, `dev/run-ep7/`, `dev/run-ep10/`: run kits of earlier episodes, present at this tag. Do not copy them.
- `dev/run-ep11/undo-task8.log` and `dev/run-ep11/README.md`: run artefacts.
- The `client_id` allowlist and the Deliveries page: Ep 9 and Ep 10.
