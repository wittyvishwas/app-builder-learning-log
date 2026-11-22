# Agent hand-off: App Builder Ep 5, log forwarding to New Relic

Give this file to your coding agent (Claude Code or similar) inside your own App Builder project. It builds what Ep 5 built, in your project. Post: <https://mageminion.com/app-builder-ep5-log-forwarding-new-relic/>. Code: tag `ep5-log-forwarding` in https://github.com/wittyvishwas/app-builder-learning-log.

This episode adds no code. Log forwarding is workspace configuration, set with one `aio` command. The reference repo only holds the README commands and the `LOG_LEVEL` input pattern.

## Before you start
- Builds on Ep 1 (the project, `.env` kept out of git) and Ep 3 (a job that logs; any action that logs works instead).
- The project must be bound to the workspace you forward from. That is the namespace in `.env`, key `AIO_runtime_namespace`. `aio where` shows only the CLI's global selection, so it can differ.
- The human must have:
  - Adobe Developer Console access, `aio login` done, and a non-Production workspace selected.
  - The latest CLI: `npm install -g @adobe/aio-cli`.
  - A New Relic account and an existing **INGEST - LICENSE** key. App Builder can't create one. See <https://developer.adobe.com/app-builder/docs/guides/app_builder_guides/application_logging/new-relic>.
  - The region they log in to New Relic: `https://one.newrelic.com/` (US) or `https://one.eu.newrelic.com/` (EU).
- Agent: stop and ask the human for anything in this list you can't confirm.

## Rules for the agent
- Never use a Production workspace. Never deploy without the human's yes.
- Before any `aio app deploy`, `aio app use`, onboarding script or `aio app config set`, run `aio where` and show the human the workspace. Also confirm, without printing it, that `AIO_runtime_namespace` in `.env` is the workspace the human means: `aio where` shows only the global selection, which can differ. Ask the human to confirm. Continue only on their yes. `aio app config set log-forwarding` changes the workspace at once, with no deploy, so it needs that yes too.
- Never write secret values to files under git; `.env` and `.aio` stay out of git. Check `.gitignore` covers both.
- The license key is typed by the human into the `aio` prompt. Do not ask for it in chat, echo it, or copy it anywhere. `aio` stores it in `.env` as `NEW_RELIC__LICENSE_KEY`.
- Build only what this file lists. Keep the reader's existing names and code style; rename the episode's names (listed below) to fit.

## Get the reference code
```bash
[ -d /tmp/abl ] || git clone https://github.com/wittyvishwas/app-builder-learning-log /tmp/abl
git -C /tmp/abl fetch --tags
# then, for each Files row: git -C /tmp/abl show REF:PATH
```

## Files
| Path | Ref | What it is | Do |
|---|---|---|---|
| `README.md` | `ep11-local-testing` | Section "Log forwarding to New Relic (Ep 5)": the commands, the two region URIs, how to switch back, the errors command. Later ref on purpose: the tag's text says settings apply on the next deploy. The Stage run showed `set` applies at once, and the later README says so. | read only |
| `app.config.yaml` | `ep5-log-forwarding` | Shows the `LOG_LEVEL: info` action input on each action. | read only |

No file is copied into your project. At the tag, each action reads the level as `Core.Logger('<action>', { level: params.LOG_LEVEL || 'info' })`.

## Config
- `app.config.yaml`: check that every action you want to control has `LOG_LEVEL: info` under `inputs`. Add it if it is missing. Use `debug` only while you investigate.
  ```yaml
  inputs:
    LOG_LEVEL: info
  ```
- `.env` keys:
  - `NEW_RELIC__LICENSE_KEY`: written by `aio app config set log-forwarding`. The human supplies the key. It never goes into git.
  - `AIO_runtime_namespace`: written by `aio app use`. Read it to confirm the project is bound to the intended workspace.
- Human steps (the agent stops and asks the human to do these):
  1. Find the Log API base URI for the human's region ([Log API](https://docs.newrelic.com/docs/logs/log-api/introduction-log-api/)). Include the `https://`. A wrong region fails silently: the logs never arrive.
     - US: `https://log-api.newrelic.com/log/v1`
     - EU: `https://log-api.eu.newrelic.com/log/v1`
  2. After the human's yes on the workspace, the human runs `aio app config set log-forwarding` and answers the prompts: destination **New Relic**, the base URI, the license key. Forwarding is per workspace, so a second workspace needs the same steps after its own `aio app use`.
- Agent, after step 2: a deploy is optional here, because `set` alone sent lines on the post's workspace. If the human wants one, run `aio app deploy` only with their yes. A later deploy re-sends the stored settings unless it uses `--no-actions` or `--no-log-forwarding-update`; do not use those flags.
- Know this before you switch on: with forwarding on, `aio app logs` and `aio rt activation logs <id>` return no logs and print "Namespace is configured with custom log forwarding destination". Runtime still keeps the logs. Switching back (the same command, destination **Adobe I/O Runtime**) makes them readable again. Remove `NEW_RELIC__LICENSE_KEY` from `.env` yourself afterwards.
- Adobe's guide: <https://developer.adobe.com/app-builder/docs/guides/app_builder_guides/application_logging/logging>.

## Tests
None from this repo. This episode has no code, and `npm test` fakes everything external, so it can't prove forwarding.

## Check it works
1. Local: nothing to run. Forwarding is a workspace setting. It is not seen under `aio app dev`.
2. On the non-Production workspace, after the human says yes:
   1. `aio app config get log-forwarding` shows the destination and base URI, never the key.
   2. `set` sends its own test line, "Test from Adobe IO Runtime". Ask the human to look for it first in New Relic **Logs**.
   3. Invoke an action that logs, for example `aio rt action invoke <package>/<action> --result`. Ask the human to find the new lines in New Relic **Logs**.
   4. NRQL to pull one action's lines (use your own `package/action`):
      ```sql
      SELECT timestamp, action_short, log_stream, log_message FROM Log WHERE action_short = '<package>/<action>' SINCE 1 hour ago
      ```
   5. If nothing arrives: `aio app config get log-forwarding errors`. It shows the most recent 10 errors from up to 30 days back. With a working setup it prints "No log forwarding errors for the last configured destination 'new_relic'". The usual causes are the wrong regional base URI, a key that isn't an ingest license key, or a deploy that skipped the forwarding update.
- What a forwarded line looks like: one New Relic log per line, with attributes `action`, `action_short`, `activation_id`, `log_message`, `log_stream`, `log_timestamp`, `namespace`, `newrelic.source`, `plugin.type`, `plugin.version`, `timestamp`. There is no `message` and no `level`. The whole line, with the logger prefix, is in `log_message`, so search that field. An error line also came in on `log_stream` `stdout`.
- Log rules for the team. Check your actions' logger calls against them, list any breaks for the human, and fix only with their yes:
  - one line per significant step, with the order number or SKU in it;
  - no tokens, API keys or customer personal data;
  - errors logged with the reason and the next action, not just a stack trace.
- Limits to tell the human: an action's logs are cut off after 10 MB per activation.
- How far the post proved this: one Stage workspace, EU region. Not run: a wrong region or key, a deploy with New Relic forwarding on, a second workspace, the 10 MB cut-off, `LOG_LEVEL` filtering.

## Names to rename
| In the reference | Why it may differ in yours |
|---|---|
| `<package>/<action>`, `action_short` in the NRQL | Your package and action names. |
| `LOG_LEVEL` | Your actions may read another input name. |
| Region base URI | It depends on the human's New Relic region. |

## Not in this episode
- The New Relic dashboard for App Builder logs. The post only says it comes next. Do not build it.
- Everything under `actions/` and `scripts/` at the tag is from Ep 1 to Ep 4 (order sync, stuck orders, sync log, the database hook). Do not copy any of it for this episode.
- Events, webhooks and the mesh (Ep 6, 7, 8) are not here.
