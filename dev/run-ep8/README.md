# Ep 8 real-workspace run: API Mesh, batching, cache

Run code for measuring the Ep 8 claims on a real workspace: a fake review/stock source (`actions/fake-reviews`), mesh variants rendered from `mesh/mesh.json`, a guarded `aio api-mesh` wrapper, and query scripts. Test workspaces only: deploying the app also deploys the public fake action.

## Setup

Add to `.env` (names in `.env.dist`): `FAKE_REVIEWS_API_KEY` (16+ characters), `FAKE_REVIEWS_URL` (the action's web URL, no trailing slash), `COMMERCE_GRAPHQL_URL`, `MESH_PROJECT_TITLE`, and later `MESH_URL`. Deploy the app so the fake action exists.

## Session start

`mesh.sh` is the only way to run `aio api-mesh:*` here. It refuses unless `aio where` ends a line with `Project: $MESH_PROJECT_TITLE`. It does not select the context: select the test project and workspace yourself first, and restore the previous context when you finish. Never pass `-c` to `cache:purge` (it auto-confirms); the wrapper's `purge` runs `-a` and the CLI asks.

```bash
dev/run-ep8/mesh.sh get        # first session: expect no mesh; if one exists, stop
```

## Variants

`node dev/run-ep8/render.js <variant|all>` writes `dev/run-ep8/out/<variant>/mesh.json` with the schema files next to it (`out/` is gitignored and holds the fake key). Needs `FAKE_REVIEWS_URL`, `FAKE_REVIEWS_API_KEY`, `COMMERCE_GRAPHQL_URL`.

| Variant | Content |
|---|---|
| `v0-lower` | Tag config with `jsonSchema` (lower case) |
| `v1` | Tag config without `responseConfig.cache`, plus source `Stock`, source `ReviewOne` and field `reviewsEach` (`sourceArgs`), `includeHTTPDetails` on |
| `v2` | `v1` with `cache: true`, no `includeHTTPDetails`, CORS for `https://mmtest.example.com` |
| `v3` | `v2` plus `cacheControl: "public, max-age=100"` on the Reviews source |
| `bad-name-hyphen`, `-underscore`, `-space` | `v1` with the Reviews source named `Reviews-2`, `Reviews_2`, `Reviews 2` |
| `path-b25`, `path-b26`, `path-b24-long` | `v1` with the Reviews schema file name 25 and 26 characters long, and 24 in a subfolder |

Every fake source gets the header `x-mm-key`.

```bash
dev/run-ep8/mesh.sh create dev/run-ep8/out/v1/mesh.json && dev/run-ep8/mesh.sh status
dev/run-ep8/mesh.sh describe        # copy the endpoint into .env as MESH_URL
```

## Fake source

```bash
node dev/run-ep8/fake.js config reviews --cache 'public, max-age=300' --mode ok   # replaces the whole config of the route
node dev/run-ep8/fake.js calls [--since ms]
node dev/run-ep8/fake.js clear
node dev/run-ep8/fake.js source '/reviews?skus=a,b' --twice
```

Routes `reviews`, `stock`, `review`; modes `ok, http500, slow, badjson, reverse, short, badschema` (not every mode on every route); `--cache null` sends no Cache-Control header; default is `no-store`.

## Queries

`node dev/run-ep8/query.js <name> [--get] [--repeat n] [--origin <url>] [--wait s]` with the names in `queries.json` (`page`, `pageEach`, `commerceOnly`, `reviewsOnly`, `reviewsAndStock`, `long2000`, `long2100`). It prints status, time, the cache headers, the call ids in the body, the errors and the new fake calls per route, and appends a JSON line to `out/results.jsonl`.

## Cleanup

`dev/run-ep8/mesh.sh delete`, remove `dev/run-ep8/out/`, restore the console context.
