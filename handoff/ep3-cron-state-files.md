# Agent hand-off: App Builder Ep 3, cron, State and a lock

Give this file to your coding agent (Claude Code or similar) inside your own App Builder project. It builds what Ep 3 built, in your project. Post: <https://mageminion.com/app-builder-ep3-cron-state-files/>. Code: tag `ep3-cron-state-files` in https://github.com/wittyvishwas/app-builder-learning-log.

Ep 3 builds a job that runs every 15 minutes, finds orders stuck in `pending_payment`, and alerts the team once per order. An alarm trigger and a rule schedule it. State remembers which orders were alerted. A short State key stops overlapping runs. An optional CSV report goes to Files.

## Before you start
- Ep 2: the project exists and is deployed to a non-Production workspace. It has `app.config.yaml` and an `actions/` folder.
- The human has Adobe Developer Console access, has run `aio login`, and has a non-Production workspace selected (`aio where`).
- The human has a Commerce integration access token with read access to Sales > Operations > Orders.
- On PaaS, Commerce must accept integration tokens as bearer tokens. In the Commerce admin: Stores > Configuration > Services > OAuth > Consumer Settings > Allow OAuth Access Tokens to be used as standalone Bearer tokens. On Adobe Commerce as a Cloud Service (ACCS) that setting does not exist, and the bearer must be an IMS token.
- The human has a webhook URL to alert, such as a Slack or Teams incoming webhook.
- Agent: stop and ask the human for anything in this list you can't confirm.

## Rules for the agent
- Never use a Production workspace. Never deploy without the human's yes.
- Before any `aio app deploy`, `aio app use` or onboarding script, run `aio where` and show the human the workspace. Continue only on their yes.
- Never write secret values to files under git. `.env` and `.aio` stay out of git.
- Build only what this file lists. Keep the reader's existing names and code style; rename the episode's names (listed below) to fit.
- The action is not a web action (no `web: 'yes'`). Nothing outside should call it.
- Alert first, then remember. Mark an order in State only after the alert went out.

## Get the reference code
```bash
[ -d /tmp/abl ] || git clone https://github.com/wittyvishwas/app-builder-learning-log /tmp/abl
git -C /tmp/abl fetch --tags
# then, for each Files row: git -C /tmp/abl show REF:PATH
```
Example: `git -C /tmp/abl show ep4-database-storage:actions/stuck-orders/index.js`.

## Files
| Path | Ref | What it is | Do |
|---|---|---|---|
| `actions/stuck-orders/index.js` | `ep4-database-storage` | The job: Commerce query, State de-duplication, State lock, alert, optional Files report. | Add. Ref is the next tag because only a comment fix (70e817c) came after `ep3-cron-state-files`. No other lines differ, and it has no Ep 9 code. |
| `test/stuck-orders.test.js` | `ep3-cron-state-files` | Unit tests with Commerce, the webhook, State and Files faked. | Add. |
| `test/helpers.js` | `ep3-cron-state-files` | Test fakes: `fakeState`, `scriptedFetch`, `order`. | Add, or merge these three exports into the reader's helpers. |
| `app.config.yaml` | `ep3-cron-state-files` | The whole reference config. Only the `ops` package is Ep 3. | Read only. Merge the `ops` package (action, trigger, rule) into yours. |
| `.env.dist` | `ep3-cron-state-files` | Names of the `.env` keys. | Read only. Use the Ep 3 block (`COMMERCE_BASE_URL`, `COMMERCE_TOKEN`, `ALERT_WEBHOOK_URL`). |
| `package.json` | `ep3-cron-state-files` | Dependency versions and the `jest` test script. | Read only. Add the dependencies and `jest` to the reader's file. |

## Config
`app.config.yaml`: add this package under `application.runtimeManifest.packages`. It is the Ep 3 part of the file at the tag.
```yaml
      ops:
        actions:
          stuck-orders:
            function: actions/stuck-orders/index.js
            runtime: nodejs:20
            inputs:
              LOG_LEVEL: info
              COMMERCE_BASE_URL: $COMMERCE_BASE_URL
              COMMERCE_TOKEN: $COMMERCE_TOKEN
              ALERT_WEBHOOK_URL: $ALERT_WEBHOOK_URL
              STUCK_AFTER_MINUTES: 30
              SAVE_REPORT: false
            annotations:
              final: true
        triggers:
          every15Minutes:
            feed: /whisk.system/alarms/alarm
            inputs:
              cron: '*/15 * * * *'
        rules:
          stuckOrdersSchedule:
            trigger: every15Minutes
            action: stuck-orders
```
- The cron expression is in UTC. A "9 a.m. India time" job is `30 3 * * *`. The feed also has `/whisk.system/alarms/interval` and `/whisk.system/alarms/once`.
- `SAVE_REPORT: false` is the optional Files report. Set it to `true` only if the human wants a CSV of each run's new alerts, one file per day under `reports/stuck-orders/`.

Dependencies (versions at the tag): `@adobe/aio-sdk` ^6.0.0, `@adobe/aio-lib-state` ^5.4.0, `@adobe/aio-lib-files` ^4.1.4, and `jest` as a dev dependency. The lock needs `@adobe/aio-lib-state` 5.4 or later, because `ifNotExists` is ignored without error in older 5.x releases. Check with `npm ls @adobe/aio-lib-state`. If you take `State` from `@adobe/aio-sdk`, check the version the same way.

`.env` keys, by name. Leave the values empty and tell the human to fill them in:
- `COMMERCE_BASE_URL`: the store base URL, with or without a trailing slash. The human provides it.
- `COMMERCE_TOKEN`: the integration access token with read access to orders. The human provides it.
- `ALERT_WEBHOOK_URL`: the incoming-webhook URL that receives the alert. The human provides it.

Human steps (agent: stop and ask the human to do these):
- Create the Commerce integration token with read access to Sales > Operations > Orders.
- On PaaS, enable Stores > Configuration > Services > OAuth > Consumer Settings > Allow OAuth Access Tokens to be used as standalone Bearer tokens.
- Create the Slack or Teams incoming webhook.

## Tests
- Add `test/stuck-orders.test.js` and `test/helpers.js` from the Files table. Add `jest` and a `"test": "jest"` script if the project has none.
- The tests need no network. They fake Commerce, the webhook, State and Files. They prove the logic (query, alert-then-remember, lock, report), not a deployment.
- Run `npm test`. Fix failures that come from renamed paths before you go on.

## Check it works
1. Local first. Run `npm test`. Calling the action under `aio app dev` with a filled `.env` queries the real Commerce, posts to the real alert webhook and writes real State, so do that only with the human's yes. Under `aio app dev` the non-web action is served over HTTP. Without `COMMERCE_BASE_URL` it answers 500. There is no local trigger: the alarm never fires under `aio app dev`. State works from localhost. Files fails locally with `ERROR_BAD_CREDENTIALS`, so leave `SAVE_REPORT` false when you test locally. (Source: Ep 11, <https://mageminion.com/app-builder-ep11-local-testing/>.)
2. After the human says yes: run `aio where` and show it, then `aio app deploy`. The deploy creates the trigger and the rule.
3. Run the job once by hand instead of waiting for the clock: `aio rt action invoke ops/stuck-orders --result`.
4. Inspect the schedule and runs:
   ```bash
   aio rt trigger list
   aio rt rule list
   aio rt activation list
   aio app logs
   ```
5. If the rule shows as inactive, nothing runs and nothing errors. `aio rt rule enable stuckOrdersSchedule` fixes it. `aio app deploy` can switch a disabled rule back on. If the job should not run yet, run `aio rt rule disable stuckOrdersSchedule` after each deploy. Ask the human before you enable or disable a rule.

How far this is proven (README at the tag): the job is unit-tested. On a real Stage workspace, State stored a value with a 7-day time to live, a deploy created the trigger and rule, and `aio rt rule disable` stopped them. The alarm fired, but without Commerce credentials the job returned an error, so the job and its alert have not run for real. The Files write has not run on a real workspace.

## Names to rename
| In the reference | Why it may differ in yours |
|---|---|
| `ops` (package) and `ops/stuck-orders` | Your package and action names. The invoke command above must match. |
| `every15Minutes`, `stuckOrdersSchedule` | Trigger and rule names. Pick names that fit your project. The rule name appears in the enable and disable commands. |
| `pending_payment`, `STUCK_AFTER_MINUTES` | The order status and cut-off your shop treats as stuck. |
| `stuck-` and `lock-` State key prefixes | Prefix keys with your job name so two jobs in one workspace never collide. |
| `reports/stuck-orders/` | The Files path of the optional report. |

## Not in this episode
- The tag also contains the `order-sync` package (`actions/export-order/`, `actions/export-order-retry/`, `actions/order-sync/`) and its tests. They are earlier or later episodes' code (Ep 1 and Ep 10). Do not copy them.
- The `sync-log` action, Database Storage and the post-deploy hook: Ep 4. They are not at this tag.
- A `stuck_alerts` collection and an Admin UI page for the alerts: Ep 9. The files named above have none of it. If you read `actions/stuck-orders/index.js` on `main`, it has Ep 9 lines that write `stuck_alerts`. Leave those out.
- Observers, webhooks and log forwarding rows from the post's mapping table: Ep 6, Ep 7 and Ep 5.
