# Agent hand-off: App Builder Ep 9, a page in the Commerce admin (Admin UI SDK)

Give this file to your coding agent (Claude Code or similar) inside your own App Builder project. It builds what Ep 9 built, in your project. Post: <https://mageminion.com/app-builder-ep9-admin-ui-sdk/>. Code: https://github.com/wittyvishwas/app-builder-learning-log. This hand-off is for Admin UI SDK **version 2** (`commerce/backend-ui/2`, App Management), which is at the tag `ep9-admin-ui-sdk-v2`. The version 1 code the first post was written against is at the tag `ep9-admin-ui-sdk` (`src/commerce-backend-ui-1/`, a `registration` action); it is not described here.

## Before you start
- This builds on Ep 1 (project layout), Ep 3 (the stuck-order job), and Ep 4 (Database Storage: the project has a database, a post-deploy index hook and IMS credentials for `aio-lib-db`).
- The human must have: Adobe Developer Console access, `aio login` done, and a non-Production workspace selected (check with `aio where`). The workspace must include the I/O Management API.
- Node 22 or later (`@adobe/aio-commerce-lib-app` and `@adobe/aio-commerce-lib-admin-ui` declare `engines.node >=22`).
- The human must have a **hosted** Adobe Commerce: Adobe Commerce as a Cloud Service, or Adobe Commerce 2.4.8 or later (cloud or on-premises), with Admin UI SDK 4.2.0 or later and App Management available in the admin. Adobe: "App Management is **not supported** for **local** Adobe Commerce installations at this time." (<https://github.com/AdobeDocs/commerce-extensibility/blob/main/src/pages/app-management/index.md>). On a local Commerce the agent can build, test and deploy, but the page cannot be associated or opened. Say so to the human before starting.
- The Commerce admin must use Adobe IMS sign-in, in the same IMS org as the App Builder project: <https://developer.adobe.com/commerce/extensibility/admin-ui-sdk/installation/>. It applies to every admin user.
- The admin who associates the app needs the App Management resource under Admin UI SDK in User Roles.
- Agent: stop and ask the human for anything in this list you can't confirm.

## Rules for the agent
- Never use a Production workspace. Never deploy without the human's yes.
- Before any `aio app deploy`, `aio app use` or onboarding script, run `aio where` and show the human the workspace. Continue only on their yes.
- Never write secret values to files under git. `.env` and `.aio` stay out of git.
- Build only what this file lists. Keep the reader's existing names and code style; rename the episode's names (listed below) to fit.
- This is Admin UI SDK version 2. Versions 1 and 2 are not compatible: pick one per app, and do not mix in version 1 code (no `registration` action, no `commerce/backend-ui/1`).
- Do not hand-write the files under `.generated/`. Run `npx aio-commerce-lib-app generate all` and commit what it writes.
- Never rely on the page being hidden. Every action the page calls stays locked down (see Config).
- The generated `app-management/*` actions are web actions gated only by `require-adobe-auth` (the installation action takes the app's client secret). After the human has associated and tested the app in a test workspace, offer to undeploy them (`aio rt action delete app-management/<name>`). Do not leave them in a shared workspace.

## Get the reference code
```bash
[ -d /tmp/abl ] || git clone https://github.com/wittyvishwas/app-builder-learning-log /tmp/abl
git -C /tmp/abl fetch --tags
# then, for each Files row: git -C /tmp/abl show REF:PATH
```

## Files
Ep 9 is the stuck-orders page only. The `list-deliveries` and `retry-delivery` actions and the Deliveries tab belong to Ep 10: leave them out.

| Path | Ref | What it is | Do |
|---|---|---|---|
| `app.config.yaml` | `ep9-admin-ui-sdk-v2` | Root config: the `extensions` entries (`commerce/backend-ui/2`, then `commerce/extensibility/1`, in that order), and `include-ims-credentials: true` on the `ops/stuck-orders` action | merge into yours (only those parts; `main` carries other episodes' actions) |
| `actions/stuck-orders/index.js` | `ep9-admin-ui-sdk` | The Ep 3 job, extended: each alert it sends is also upserted into the `stuck_alerts` collection | merge into yours |
| `package.json` | `ep9-admin-ui-sdk-v2` | Dependencies and scripts for v2: `@adobe/aio-commerce-lib-app`, `@adobe/aio-commerce-lib-admin-ui`, `@adobe/aio-commerce-sdk`, `@react-spectrum/s2`, `react` and `react-dom` 19, the TypeScript and Babel devDependencies, the `postinstall` script, the `imports` map (`#app.commerce.config`, `#web/*`) and the two parcel keys (without them the S2 CSS does not bundle). Compare with Adobe's sample `package.json` | read only: add those to yours, keep your own versions of the rest |
| `scripts/post-deploy-db-setup.js` | `ep9-admin-ui-sdk` | The Ep 4 post-deploy hook. Ep 9 adds the `stuck_alerts` indexes: `order_1` (unique) and `handled_1_at_-1` | merge into yours (only the `stuck_alerts` entry in `INDEXES`) |
| `app.commerce.config.ts` | `ep9-admin-ui-sdk-v2` | The App Management config: `metadata` (`id`, `displayName`, `description`, `version`) and one `adminUi.menu` entry (`id` `StuckOrders::stuck`, `label`, `description`, `pageTitle`). No `parentMenu`, so the menu sits under Apps. No `aclProtected` | add (rename) |
| `install.yaml` | `ep9-admin-ui-sdk-v2` | The two extension points, `commerce/backend-ui/2` and `commerce/extensibility/1` | add |
| `tsconfig.json` | `ep9-admin-ui-sdk-v2` | TypeScript config for `app.commerce.config.ts`, from Adobe's sample | add |
| `webpack-config.cjs` | `ep9-admin-ui-sdk-v2` | `ts-loader` for the TypeScript config, from Adobe's sample | add |
| `src/commerce-backend-ui-2/ext.config.yaml` | `ep9-admin-ui-sdk-v2` | Extension config: `web: web-src`, the generated hooks, `operations.view`, and the `list-alerts` and `mark-handled` actions. It carries the `ALLOWED_CLIENT_IDS` input (the client_id allowlist, part of Ep 9). Leave out the `list-deliveries` and `retry-delivery` action blocks: they are Ep 10 | add (without the two Ep 10 blocks) |
| `src/commerce-backend-ui-2/actions/list-alerts/index.js` | `ep9-admin-ui-sdk-v2` | Returns the open alerts from `stuck_alerts`, newest first. It calls the allowlist check first | add |
| `src/commerce-backend-ui-2/actions/mark-handled/index.js` | `ep9-admin-ui-sdk-v2` | Sets `handled: true` on one alert. It calls the allowlist check first | add |
| `src/commerce-backend-ui-2/actions/allowed-client.js` | `ep9-admin-ui-sdk-v2` | Second gate: checks the token's `client_id` against `ALLOWED_CLIENT_IDS` | add |
| `src/commerce-extensibility-1/ext.config.yaml` | `ep9-admin-ui-sdk-v2` | The App Management extension: hooks and the generated `app-management` package (`app-config`, `association`, `installation`) | read only: run `npx aio-commerce-lib-app generate all`, which writes it and `.generated/` |
| `src/commerce-extensibility-1/.generated/app.commerce.manifest.json` | `ep9-admin-ui-sdk-v2` | What `generate all` made from the config; Commerce reads it through the `app-config` action | read only: compare with your own output |
| `src/commerce-backend-ui-2/web-src/index.html` | `ep9-admin-ui-sdk-v2` | Page shell: loads `src/app.tsx` | add |
| `src/commerce-backend-ui-2/web-src/index.css` | `ep9-admin-ui-sdk-v2` | Page styles, from the sample | add |
| `src/commerce-backend-ui-2/web-src/src/app.tsx` | `ep9-admin-ui-sdk-v2` | The entry: `createExtensionApp` from `@adobe/aio-commerce-lib-admin-ui/web` with the menu page and `metadata.extensionId` from the app config. There is no `ExtensionRegistration` component | add |
| `src/commerce-backend-ui-2/web-src/src/pages/main-page.tsx` | `ep9-admin-ui-sdk-v2` | `useIms()` and the tabs; render only the StuckAlerts tab (Ep 10's Deliveries tab stays out) | add (rename) |
| `src/commerce-backend-ui-2/web-src/src/components/StuckAlerts.tsx` | `ep9-admin-ui-sdk-v2` | The alerts table (React Spectrum 2) and the Mark handled button | add |
| `src/commerce-backend-ui-2/web-src/src/utils.ts` | `ep9-admin-ui-sdk-v2` | `callAction` (calls the actions with `Authorization: Bearer` and `x-gw-ims-org-id`) and `newestFirst` | add |

Tests to add from `test/`, all at `ep9-admin-ui-sdk-v2`: `ext-config.test.js` (the actions' entries and the two extension points; trim the action names to `list-alerts` and `mark-handled` and drop the retry-delivery inputs test), `commerce-app-config.test.js` (the menu validates against the generated manifest; a menu without `description` fails), `list-alerts.test.js`, `mark-handled.test.js`, `allowed-client.test.js`, `stuck-orders.test.js`, `helpers.js` (the fake database, `tokenFor`, `authed`), and `test/web/` with `jest.config.js` (the page under jest in jsdom; from `test/web/page.test.tsx` drop the Deliveries describe block, the "Deliveries tab" test and the Deliveries-tab assertion, since Ep 9 leaves Ep 10's Deliveries out: a `web` project with inline Babel presets and a mock for `@adobe/aio-commerce-lib-admin-ui/web`). Add the `stuck_alerts` cases from `test/db-setup.test.js` at `ep9-admin-ui-sdk`: the index names `order_1` and `handled_1_at_-1` with `order_1` unique, and the test that the unique index rejects a second alert for the same order. Leave the other collections' cases out.

## Config
- `app.config.yaml` entries (the extension points; version 2). Keep this order, with `commerce/extensibility/1` last:
```yaml
extensions:
  commerce/backend-ui/2:
    $include: src/commerce-backend-ui-2/ext.config.yaml
  commerce/extensibility/1:
    $include: src/commerce-extensibility-1/ext.config.yaml
```
- Also in `app.config.yaml`: the `ops/stuck-orders` action needs `include-ims-credentials: true`, because it now writes to the database.
- There is no registration action. Commerce reads the menu from the generated `app-management/app-config` action. `npx aio-commerce-lib-app generate all` writes `src/commerce-extensibility-1/.generated/`; `aio app build` runs the same step through the `pre-app-build` hooks, and `npm install` runs the `postinstall` hook. After `npm ci` in a clean clone, `git status` should be empty.
- `src/commerce-backend-ui-2/ext.config.yaml`: every action the page calls is a web action (`web: 'yes'`) with `require-adobe-auth: true` and `final: true`. The two data actions (`list-alerts`, `mark-handled`) also get `include-ims-credentials: true` and an `ALLOWED_CLIENT_IDS: $ALLOWED_CLIENT_IDS` input. Copy the structure from the file at `ep9-admin-ui-sdk-v2`. The generated App Management actions run on `nodejs:24`; the episode's data actions are pinned to `nodejs:20`.
- Lock-down, as the post describes: `require-adobe-auth: true` rejects calls without a valid token. The actions have no per-action permissions, so each data action also checks the token's `client_id` against the allowlist and refuses anything else. The token can belong to an integration, not a person: do not treat it as the admin user's identity.
- `aclProtected` (not used here): `adminUi.menu.aclProtected: true` gates the menu item behind its own Commerce ACL resource, per admin role. It needs the app to be associated with a Commerce instance, and an action can ask Commerce with `POST /V1/adminuisdk/permission/check` (body `{ "resource": "<ACL resource id>" }`). Leave it off unless the human asks.
- `.env` keys (names only; the human provides the values):
  - `ALLOWED_CLIENT_IDS`: comma-separated IMS client ids allowed to call the data actions. Empty refuses every call. The first refused call logs the caller's client id at warn level (`aio rt activation logs`), so the human can read it there. The v2 page token's `client_id` may differ from version 1's; it has not been observed. Do not guess it.
  - `COMMERCE_BASE_URL`, `COMMERCE_TOKEN`, `ALERT_WEBHOOK_URL`: for the Ep 3 job, as before.
  - `IMS_OAUTH_S2S_CLIENT_ID`, `IMS_OAUTH_S2S_CLIENT_SECRET`, `IMS_OAUTH_S2S_ORG_ID`, `IMS_OAUTH_S2S_SCOPES`: for the Ep 4 post-deploy hook, as before.
- `scripts/post-deploy-db-setup.js`: add the `stuck_alerts` indexes to the hook's `INDEXES` (`order_1` unique, `handled_1_at_-1`). The Ep 4 hand-off leaves them out because they are Ep 9's. The hook creates them on the next deploy.
- `src/commerce-backend-ui-2/web-src/src/config.json` is generated by `aio app build`. Keep it out of git.
- Human steps in the Commerce admin (hosted Commerce only). The agent stops and asks the human to do these:
  1. Give the admin who associates the app the App Management resource under Admin UI SDK, and the admins who open the page the Admin App Permissions resource.
  2. Open Apps > App Management, associate the deployed app (pick the project and workspace from the repo's `.aio`, not `aio where`) and install it. The deploy must be a plain `aio app deploy`: after `--no-publish` the workspace has no registered extension points and association fails with "not compatible with Adobe Commerce" (`app-not-associable`).
  3. Reload the admin. Stuck orders appears under Apps.
  Adobe's steps: <https://github.com/AdobeDocs/commerce-extensibility/blob/main/src/pages/app-management/index.md>.
- There is no local testing path into a v2 admin: Commerce loads the page from the deployed App Registry URL, and `useIms()` returns an error outside a host.

## Tests
- Run `npm test`. It covers the actions (database faked), the config files and the page's logic under jest. It does not open the page in a Commerce admin.
- `npx aio-commerce-lib-app generate all` should leave `git status` clean when the config has not changed. A bad menu (`id` with a hyphen, a missing `description`) fails there with a schema error that names the field.
- Lock file: if `~/.npmrc` sets `legacy-peer-deps=true`, regenerate with `NPM_CONFIG_USERCONFIG=/dev/null npx -y npm@11 install --legacy-peer-deps=false`, or peer dependencies drop out of the lock.

## Check it works
1. Local first (no deploy). `npm test`, then `npx aio-commerce-lib-app generate all` and `aio app build`. Optionally, Adobe's own sample before your code, to rule out configuration problems: <https://github.com/adobe/adobe-commerce-samples/tree/main/admin-ui-sdk/v2/menu/custom-menu>.
2. Then deployed to the non-Production workspace, after the human says yes (after `aio config get project --json` is shown): `aio app deploy` (with publish; see step 2 of the human steps). `aio rt action list` should show the `app-management` actions and the four `StuckOrders` actions, and no `admin-ui-sdk/registration`.
3. On a hosted Commerce, after association: Stuck orders in the Apps menu, listing open alerts newest first. Before that, check the built bundle: `grep -c 'require("./config.json")' dist/commerce-backend-ui-2/web-prod/*.js` must print 0 (Parcel inlined the action URLs); otherwise the page fails in the admin with "Cannot find module './config.json'".
4. Lock-down checks on the deployed `list-alerts` action: no token, a made-up token, or a valid token without the org header must answer 401. A valid token whose `client_id` is not in `ALLOWED_CLIENT_IDS` must answer 403. The page's own calls (admin token, client on the allowlist) answer 200.
5. Press Mark handled on a test alert. The alert gets `handled: true`. Ship read-only first: add the button only after you have tested who can press it.
6. When done testing, offer to undeploy the `app-management/*` actions from the test workspace.
- Proven for version 2 on a hosted Commerce 2.4.8 (tag `ep9-admin-ui-sdk-v2.1`): association and install, the page in the admin, the header pair, the page token against the allowlist (unchanged from version 1), the list, Mark handled (the immediate re-list can be stale; a reload is right) and Deliveries. Not proven: `aclProtected`. Version 1 (tag `ep9-admin-ui-sdk`) was proven on Stage with a local Commerce admin.

## Names to rename
| In the reference | Why it may differ in yours |
|---|---|
| `Stuck orders` (menu label and page title) | Your menu label |
| `stuck-orders` (`metadata.id`), `StuckOrders::stuck` (menu id) | `metadata.id`: letters, digits and hyphens only. Menu id: letters, digits, `/`, `:`, `_` |
| `stuck_alerts` (collection) | Your collection name, if you already have one |
| `StuckOrders` (action package) | Your package name |
| `ops/stuck-orders` | Your Ep 3 job's package and action name |
| `commerce/backend-ui/2` and `src/commerce-backend-ui-2` | Only if your extension layout differs |

## Not in this episode
- `list-deliveries`, `retry-delivery`, the Deliveries tab and the retry button: Ep 10.
- `actions/export-order`, `actions/export-order-retry`, `actions/order-sync/`, `actions/sync-log`: Ep 4 and Ep 10.
- `actions/order-placed`: Ep 6. `actions/cart-check` and `commerce/webhooks.xml`: Ep 7. `mesh/`: Ep 8.
- `actions/ep11-probe`, `dev/run-ep11/`: Ep 11.
- Version 1 (`commerce/backend-ui/1`, the `registration` action): tag `ep9-admin-ui-sdk`.
- Grid columns, mass actions, order-view buttons and custom ACL resources (`adminUi.acl`): not built here.
