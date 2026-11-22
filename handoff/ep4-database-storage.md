# Agent hand-off: App Builder Ep 4, Database Storage for a sync log

Give this file to your coding agent (Claude Code or similar) inside your own App Builder project. It builds what Ep 4 built, in your project. Post: <https://mageminion.com/app-builder-ep4-database-storage/>. Code: tag `ep4-database-storage` in https://github.com/wittyvishwas/app-builder-learning-log.

Ep 4 adds Database Storage, the document database for Runtime actions. It provisions the database in `app.config.yaml`, adds a `sync-log` action that writes and reads a collection, and creates indexes from a post-deploy hook.

## Before you start
- Episodes 1 to 3: the project exists, has `app.config.yaml` and an `actions/` folder, and deploys to a non-Production workspace. Ep 3 used State for flags with a time to live. Ep 4 is for records you query.
- The human has Adobe Developer Console access, has run `aio login`, and has a non-Production workspace selected (`aio where`).
- The human has the latest CLI: `npm install -g @adobe/aio-cli`. Ask the human to run it if the CLI is old.
- The human adds the App Builder Data Services API to the workspace in Developer Console. The I/O Management API is optional.
- The workspace has an OAuth server-to-server credential, and a new access token was generated after the Data Services API was added.
- Agent: stop and ask the human for anything in this list you can't confirm.

## Rules for the agent
- Never use a Production workspace. Never deploy without the human's yes. Each workspace has its own database, so Stage and Production are two databases.
- Before any `aio app deploy`, `aio app use` or onboarding script, run `aio where` and show the human the workspace. Continue only on their yes.
- Never write secret values to files under git. `.env` and `.aio` stay out of git.
- Build only what this file lists. Keep the reader's existing names and code style; rename the episode's names (listed below) to fit.
- Provisioning rewrites `app.config.yaml` as plain YAML and every comment in it is lost. Commit first, and check `git diff` after the first deploy that provisions.
- Store IDs, statuses and timestamps. Do not copy customer or order details into the database. Look them up from Commerce when needed.
- Index small fields only. The indexed fields of one document can't exceed 2,048 bytes combined. Index the SKU, not the error message.

## Get the reference code
```bash
[ -d /tmp/abl ] || git clone https://github.com/wittyvishwas/app-builder-learning-log /tmp/abl
git -C /tmp/abl fetch --tags
# then, for each Files row: git -C /tmp/abl show REF:PATH
```
Example: `git -C /tmp/abl show ep4-database-storage:actions/sync-log/index.js`.

## Files
| Path | Ref | What it is | Do |
|---|---|---|---|
| `actions/sync-log/index.js` | `ep4-database-storage` | The action: insert one row per export attempt, return the newest failure for the SKU. | Add. Side commit 7e92622 is already on this tag: it uses `find().sort().limit(1)` as the post does, and logs the message only. |
| `scripts/post-deploy-db-setup.js` | `ep11-local-testing` | The post-deploy hook that creates indexes. | Add, with edits (see below). The Ref is later because the post's closing note says the hook now accepts the scopes as a JSON array and the namespace as `AIO_runtime_namespace`. Those fixes are not on the tag. |
| `test/db-setup.test.js` | `ep11-local-testing` | Tests for the hook, including `parseScopes` and the namespace fallback. | Add, with edits (see below). |
| `test/sync-log.test.js` | `ep4-database-storage` | Tests for `sync-log`. | Add. |
| `test/helpers.js` | `ep4-database-storage` | Test fakes, including `fakeDb` for aio-lib-db. | Add, or merge `fakeDb` into the reader's helpers. |
| `test/fakedb.test.js` | `ep4-database-storage` | Tests for the `fakeDb` helper. | Add. |
| `app.config.yaml` | `ep4-database-storage` | The whole reference config. Only the `hooks`, `database` and `sync-log` entries are Ep 4. | Read only. Merge those three entries into yours. |
| `package.json` | `ep4-database-storage` | Dependency versions. | Read only. Add `@adobe/aio-lib-db` to the reader's dependencies. |

Edits to the two Ref `ep11-local-testing` files. That ref also holds later episodes' code. Leave it out:
- In `scripts/post-deploy-db-setup.js`, keep only `export_runs.sku_1_at_-1` in `INDEXES`. Remove `order_1_status_1` and `status_1_nextAt_1` (Ep 10), `order_claims` (Ep 6) and `stuck_alerts` (Ep 9). The README at the tag says those indexes are for later episodes. Keep `parseScopes` and the namespace fallback.
- In `test/db-setup.test.js`, remove the assertions and tests about `order_claims`, `stuck_alerts`, `status_1_nextAt_1` and `order_1_status_1`. Change the expected index names and counts to match the single index you kept. Keep the `parseScopes` tests and the namespace tests.

## Config
`app.config.yaml`: add these entries. They are the Ep 4 part of the file at the tag.
```yaml
application:
  hooks:
    post-app-deploy: node scripts/post-deploy-db-setup.js
  runtimeManifest:
    database:
      auto-provision: true
      region: emea
    packages:
      order-sync:
        actions:
          sync-log:
            function: actions/sync-log/index.js
            runtime: nodejs:20
            web: 'no'
            inputs:
              LOG_LEVEL: info
            annotations:
              include-ims-credentials: true
              final: true
```
- Put `sync-log` under a package that exists in the reader's project. The reference uses `order-sync`.
- `region`: one of `amer` (the default), `emea`, `apac` or `aus`. Ask the human which region is closest to their Commerce instance. Moving it later means deleting and reprovisioning. The region in `actions/sync-log/index.js` (`libDb.init`) must match this value.
- `include-ims-credentials: true` is needed on every action that uses the database. Without it the action gets no credentials to create the IMS token. Without a fresh token, `init` fails with an authorisation error.
- Auto-provisioning happens on `aio app deploy`, not on `aio app run` or `aio app dev`. To provision by hand: `aio app db provision --region emea`. It also writes a `database` block with `auto-provision: false` and the region.
- Install the library: `npm install @adobe/aio-lib-db` (`^1.1.0` at the tag).

`.env` keys, by name. Leave the values empty and tell the human to fill them in. Do not write them yourself. The post-deploy hook reads them to create the indexes:
- `IMS_OAUTH_S2S_CLIENT_ID`, `IMS_OAUTH_S2S_CLIENT_SECRET`, `IMS_OAUTH_S2S_ORG_ID`: the workspace's OAuth server-to-server credential, from Developer Console. The human provides them. If the project was bound with `aio app use`, they may already be there.
- `IMS_OAUTH_S2S_SCOPES`: the credential's scopes. The hook accepts a JSON array (what `aio app use` writes) or a comma-separated list.
- `AIO_runtime_namespace`: the workspace's Runtime namespace. `aio app use` writes it. The hook also accepts `AIO_RUNTIME_NAMESPACE`. Do not add a second line for the other spelling: aio treats both as one setting, including the deploy target.

Human steps (agent: stop and ask the human to do these):
- In Developer Console, add the App Builder Data Services API to the workspace. Then generate a new access token for the credential. See [Database Storage in the App Builder docs](https://developer.adobe.com/app-builder/docs/guides/app_builder_guides/storage/database).
- Choose the region.
- If `init` fails with an authorisation error, check three things in order. Is the Data Services API on the workspace? Was a new access token generated after you added it? Is the annotation on this action?

## Tests
- Add the test files from the Files table: `test/sync-log.test.js`, `test/db-setup.test.js` (edited), `test/fakedb.test.js` and `test/helpers.js`. Add `jest` and a `"test": "jest"` script if the project has none.
- The tests fake aio-lib-db with `fakeDb` from `test/helpers.js`. They need no network and prove the logic, not the real service.
- Run `npm test`.

## Check it works
1. Local first. Run `npm test`. Under `aio app dev`, Database Storage works: aio-lib-db connects to the workspace's real database, so test rows land in the Stage database. Delete your test rows afterwards. The post-deploy index hook runs only on a deploy. (Source: Ep 11, <https://mageminion.com/app-builder-ep11-local-testing/>.)
2. After the human says yes: run `aio where` and show it, then commit, then `aio app deploy`. Check `git diff` for lost comments in `app.config.yaml`.
3. Check the database and the indexes:
   ```bash
   aio app db status
   aio app db ping
   aio app db index list export_runs
   ```
4. Invoke `sync-log` by hand with a `sku` and a `status`. It should insert a row and return the newest failure for that SKU as `lastFailure`. With `sku` or `status` missing it answers 400.
5. Look inside without writing code:
   ```bash
   aio app db collection list
   aio app db document find export_runs '{}'
   aio app db document count export_runs
   aio app db stats
   ```
   `document find` returns 20 documents by default and 100 at most.
6. Gotcha: `findOne` with no match throws a `DbError` ("Document not found") on `aio-lib-db` 1.1.0 instead of returning `null`. The action uses `find` with `limit(1)` to avoid it. If you use `findOne`, catch that error.

How far this is proven (README and post): on a real Stage workspace, `aio app deploy` provisioned the database in `emea`, the hook created indexes with the workspace's OAuth credential, and `sync-log` inserted a row, returned it, and answered 400 when `sku` was missing. The real run caught that `aio app use` writes the scopes as a JSON array and the namespace as `AIO_runtime_namespace`. The hook now accepts both.

## Names to rename
| In the reference | Why it may differ in yours |
|---|---|
| `order-sync` (package) | Your package name for the `sync-log` action. |
| `sync-log` | Your action name. |
| `export_runs` | Your collection name. |
| `sku`, `status`, `error`, `at` | Your document fields. Index only small fields. |
| `emea` | Your region. Set the same value in `app.config.yaml` and in `libDb.init`. |
| `sku_1_at_-1` | The index name. It is spelled out so a second hook run can tell the index already exists. |

## Not in this episode
- The tag also contains the `order-sync` actions (`actions/export-order/`, `actions/export-order-retry/`, `actions/order-sync/`), `actions/stuck-orders/index.js` and their tests. They belong to other episodes (Ep 1, Ep 3, Ep 10). Do not copy them.
- Ep 3's `stuck-orders` job: Ep 3. On `main` it also writes a `stuck_alerts` collection (Ep 9). Leave that out.
- The hook at `ep11-local-testing` (the ref you copy) lists indexes for later episodes: `order_claims` (Ep 6), `stuck_alerts` (Ep 9), and `order_1_status_1` and `status_1_nextAt_1` on `export_runs` (Ep 10). At the Ep 4 tag it already has `order_1_status_1` and the two `stuck_alerts` indexes. Do not create any of them here. The Ep 9 hand-off adds the `stuck_alerts` indexes.
- The Admin UI page (Ep 9), the claim-before-send logic (Ep 6) and the `findOneOrNull` helper in `store.js` (Ep 10).
- Test helpers beyond `fakeDb` that later episodes added to `test/helpers.js` on `main`. This file uses the tag's version.
