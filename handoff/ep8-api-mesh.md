# Agent hand-off: App Builder Ep 8, one API Mesh endpoint and its cache

Give this file to your coding agent (Claude Code or similar) inside your own App Builder project. It builds what Ep 8 built, in your project. Post: <https://mageminion.com/app-builder-ep8-api-mesh/>. Code: tag `ep8-api-mesh` in https://github.com/wittyvishwas/app-builder-learning-log. The mesh files are pinned to a later ref, `ep11-local-testing`, for a fix the tag does not have (see Files).

Goal: one GraphQL endpoint in front of Commerce GraphQL and a REST reviews API. A product gets an `externalReviews` field, joined in one batched call per query. The mesh cache is on.

## Before you start
- Builds on Ep 2 (the Adobe I/O CLI, logged in, workspace selected). No other episode's code is needed.
- The human must have:
  - Adobe Developer Console access, `aio login` done, a non-Production workspace selected (`aio where`).
  - Node.js and the Adobe I/O CLI.
  - Their Commerce GraphQL endpoint.
  - A REST API to join. Any JSON API works for practice. It must answer `GET /reviews?skus=A,B` with one list per SKU, in the order asked (see Config).
- A mesh belongs to one workspace, so Stage and Production each get their own.
- Agent: stop and ask the human for anything in this list you can't confirm.

## Rules for the agent
- Never use a Production workspace. Never deploy without the human's yes.
- Before any `aio app deploy`, `aio app use`, `aio api-mesh:create`, `aio api-mesh:update` or onboarding script, run `aio where` and show the human the workspace. Continue only on their yes.
- Never write secret values to files under git; `.env` and `.aio` stay out of git. Put no keys or tokens in `mesh.json`.
- Build only what this file lists. Keep the reader's existing names and code style; rename the episode's names (listed below) to fit.
- Name the field `externalReviews`, not `reviews`. Commerce already has `reviews` on its products, and the mesh build fails on the clash.

## Get the reference code
```bash
[ -d /tmp/abl ] || git clone https://github.com/wittyvishwas/app-builder-learning-log /tmp/abl
git -C /tmp/abl fetch --tags
# then, for each Files row: git -C /tmp/abl show REF:PATH
```

## Files
| Path | Ref | What it is | Do |
|---|---|---|---|
| `mesh/mesh.json` | `ep11-local-testing` | The mesh: sources `Commerce` (`graphql`) and `Reviews` (`JsonSchema`), the `externalReviews` type extension, the batched resolver (`keyField: sku`, `keysArg: skus`), and `responseConfig.cache: true`. Later ref on purpose: the tag still has the field named `reviews`, which fails to build against Commerce. The rename is the Ep 8 fix, made after the tag (commit 2ed4412) and shown in the post. | add, then replace the two example URLs |
| `mesh/reviews-schema.json` | `ep11-local-testing` | The response schema for the reviews call: an array of arrays of `Review`. Same as at the tag. The short file name is deliberate (see Config). | add |
| `test/mesh.test.js` | `ep11-local-testing` | Reads the two files and checks: handler spelled `JsonSchema`, resolver joins on `sku` with `skus`, the extension declares `externalReviews` and never `reviews`, `skus` is an array. Later ref for the same reason as `mesh.json`. | add |

## Config
- `mesh/mesh.json`, shape (the reference file has the full text; replace both URLs):
  ```json
  {
    "meshConfig": {
      "sources": [
        { "name": "Commerce", "handler": { "graphql": { "endpoint": "<your Commerce GraphQL endpoint>" } } },
        { "name": "Reviews", "handler": { "JsonSchema": { "baseUrl": "<your reviews API>", "operations": [ "...reviewsBySkus, as in the reference..." ] } } }
      ],
      "additionalTypeDefs": "extend type SimpleProduct {\n  externalReviews: [Review]\n}\n",
      "additionalResolvers": [ "...externalReviews resolver, as in the reference..." ],
      "responseConfig": { "cache": true }
    }
  }
  ```
- Rules that decide whether the mesh builds and answers right:
  - The REST handler is spelled `JsonSchema`. `jsonSchema` is rejected. The others are `graphql` and `openapi`.
  - Source names: letters and numbers only. A hyphen or space was rejected on Stage; stay with letters and numbers.
  - A file the mesh references: the CLI rejected a name of 26 characters or more including `.json`; 25 worked. Keep `reviews-schema.json`.
  - The example extends `SimpleProduct`. Add the same extension and resolver for any other product type your storefront shows.
  - Use [`keyField` and `keysArg`](https://developer.adobe.com/graphql-mesh-gateway/mesh/advanced/extend/batching), so 24 products make one reviews call. `sourceArgs` with `{root.sku}` and `requiredSelectionSet` works but makes one call per product (the N+1 problem).
  - Batching maps answers back to products by position, not by `sku`. The reviews API must return one list per SKU, in the order asked. A reversed answer gave the wrong reviews to most products with no error. A list one short gave `null` with errors. The mesh sends the SKUs as `skus=A,B`.
  - A `timeout` property in a `JsonSchema` handler is rejected at create. Put the timeout in the source and in the client calling the mesh.
- `.env` keys: none. The mesh holds no secrets here.
- `app.config.yaml`: no change. A mesh is not an app action.
- Cache, as the post states it (see [caching](https://developer.adobe.com/graphql-mesh-gateway/mesh/advanced/caching/) and [Cache-Control headers](https://developer.adobe.com/graphql-mesh-gateway/mesh/advanced/caching/cache-control-headers)):
  - The mesh cache is off unless `"cache": true` is under `responseConfig`. If the human has a CDN in front, set `"cache": false` so responses are not cached twice. Ask the human which.
  - A response is cached as a whole with one `Cache-Control`. The lowest value among sources wins. One `no-store` source makes the whole response `no-store`. A mesh-config default applies only to a source that sends no header.
  - Commerce's GraphQL answered `no-store` on the author's staging, so any query touching Commerce was not cached. Check what your Commerce sends.
  - Split queries by how fast the data changes. Keep customer-specific data out of cacheable queries.
  - An update does not purge. After a change, run `aio api-mesh:cache:purge -a` (or purge the CDN).
  - Browser calls directly to the mesh need CORS under `responseConfig.CORS`. Only add it if the human gives the allowed origins. CORS is not access control.
  - `includeHTTPDetails` shows source headers, the caller's IP and cookies in the answer. Keep it off in production.
- Human steps (the agent stops and asks the human to do these): none in Developer Console beyond a selected workspace. The Commerce endpoint and the reviews API come from the human.

## Tests
- Add `test/mesh.test.js`. It reads `mesh/mesh.json` and `mesh/reviews-schema.json` and needs no helpers and no deployed mesh. Run `npm test`.
- It checks the files, not the service. It does not prove the mesh builds or joins in one call.

## Check it works
1. Local, in this order:
   1. Install the plugin. This changes the CLI, so ask the human first: `aio plugins:install @adobe/aio-cli-plugin-api-mesh`.
   2. `aio api-mesh:init` creates a mesh project. Its first `npm install` took about 10 minutes. Put the reference `mesh.json` and `reviews-schema.json` in that project.
   3. `aio api-mesh run mesh.json --port 9000`. Query the new field, not just any field: `externalReviews` on products, a query with only the Commerce part, and one crossing both sources. The Ep 11 run saw one batched reviews call. It could not say whether the local server caches (both sources answered `no-store`, and no `Cache-Status` came back), so the edge cache is a deploy-only check. Commerce and the reviews API must be reachable from your machine.
   4. After Ctrl+C the mesh's worker processes may still hold the port. Stop them by hand.
2. On the non-Production workspace, after the human says yes. Check `aio where` first.
   1. Select the workspace (the plugin is installed from the local step):
      ```bash
      aio console workspace select
      ```
   2. First deploy: `aio api-mesh:create mesh/mesh.json`. Later deploys: `aio api-mesh:update mesh/mesh.json`. If unsure which, `aio api-mesh:get` says whether a mesh exists in the current workspace.
   3. `aio api-mesh:status` until provisioning is done (one to two minutes), then `aio api-mesh:describe` for the endpoint. A build error, such as the `reviews` clash, shows in `status`, not at `create`. Until the first build succeeds the endpoint says the mesh does not exist.
   4. Query `externalReviews` on a product list. Expect every product to carry its own reviews, and the reviews API to see one call for the whole list.
   5. With the cache on, repeat one query a few times. Expect `MISS` a few times before `HIT`, and `Age` counting up. The mesh sits behind several edge caches that fill separately. A `HIT` on one request says nothing about the next. Read `Cache-Status` and `Age`.
   6. Failure design: a source answering 500 gives an HTTP 500, but the body still has every product with `externalReviews: null` and one `errors` entry each. Make the client read the body and render the product. Treat the `errors` as public: they held the reviews API URL with all the SKUs.
- Not verified in the post: a `timeout` on the `graphql` or `openapi` handler, how long the mesh waits past 55 seconds, a CDN in front of the mesh, real traffic and hit ratios, a second workspace, `stale-if-error`, and updating the mesh after a source's schema changes.

## Names to rename
| In the reference | Why it may differ in yours |
|---|---|
| `Commerce`, `Reviews` | Source names. Letters and numbers only. |
| `reviewsBySkus`, `/reviews?skus={args.skus}` | Your REST API's operation and path. |
| `externalReviews`, `Review` | The field and type. Must not clash with a field Commerce already has. |
| `SimpleProduct` | Add one extension per product type you show. |
| `reviews-schema.json` | Any name of 25 characters or fewer including `.json`. |
| The two example URLs | Your Commerce GraphQL endpoint and your REST API. |

## Not in this episode
- Files present at this tag that belong to other episodes. Do not copy them:
  - `actions/order-placed/index.js`, `test/order-placed.test.js`: Commerce events (Ep 6).
  - `actions/cart-check/index.js`, `commerce/webhooks.xml`, `test/cart-check.test.js`: webhooks (Ep 7).
  - `actions/export-order/`, `actions/export-order-retry/`, `actions/order-sync/`, `test/export-order.test.js`, `test/erp.test.js`, `test/mapper.test.js`: order sync (Ep 1 and Ep 3, extended in Ep 10).
  - `actions/stuck-orders/index.js`, `test/stuck-orders.test.js`: Ep 3.
  - `actions/sync-log/index.js`, `scripts/post-deploy-db-setup.js`, `test/sync-log.test.js`, `test/db-setup.test.js`, `test/fakedb.test.js`: Ep 4.
  - `actions/utils.js`, `test/helpers.js`: shared helpers from earlier episodes.
- `dev/run-ep8/` (a fake reviews source and run scripts for the author's Stage run): the post does not use it. Your REST API is the reviews source.
- A stock service: the post's intro names one, but the mesh it builds has two sources, Commerce and Reviews.
