# Agent hand-off: App Builder Ep 2, start from a boilerplate

Give this file to your coding agent (Claude Code or similar) inside your own App Builder workspace folder. It builds what Ep 2 built, in your project. Post: <https://mageminion.com/app-builder-ep2-integration-starter-kit/>. Code: tag: none. Ep 2 uses Adobe's own repository, not the learning log.

## Before you start
- The human has an Adobe organisation with App Builder access, and a project created from the App Builder template in Developer Console. It comes with a Stage and a Production workspace.
- The human has Node.js LTS, the Adobe I/O CLI, and has run `aio login`.
- The human has a Commerce instance they can configure, with the eventing modules available. The onboarding step needs them.
- Ep 1 explains the project layout: <https://mageminion.com/app-builder-ep1-project-anatomy/>. Read it if the folder layout is new to you.
- Agent: stop and ask the human for anything in this list you can't confirm.

## Rules for the agent
- Never use a Production workspace. Never deploy without the human's yes.
- Before any `aio app deploy`, `aio app use` or onboarding script (`npm run onboard`), run `aio where` and show the human the workspace. Continue only on their yes.
- Never write secret values to files under git. `.env` and `.aio` stay out of git.
- `scripts/onboarding/config/workspace.json` holds credentials. Before you create it, check that `.gitignore` covers it. Add the ignore line first if it does not.
- Build only what this file lists. Keep the reader's existing names and code style; rename the episode's names (listed below) to fit.
- These steps were not re-run on the `legacy` tag of the kit after the post was written. Where the kit's README for that tag differs from this file, follow the README and tell the human.

## Get the reference code
Ep 2 builds on Adobe's integration starter kit, `legacy` tag. That is the version with the `env.dist` file and the onboarding scripts. The kit's `main` has moved to App Management, which this episode does not use.

```bash
git clone --branch legacy https://github.com/adobe/commerce-integration-starter-kit.git order-sync
```

Source pages: [integration starter kit](https://developer.adobe.com/commerce/extensibility/starter-kit/integration/) and [the kit's repository](https://github.com/adobe/commerce-integration-starter-kit).

## Files
None from this repo. The project comes from the starter kit clone above.

## Config
Do these in order. Stop and ask the human at each step marked "human".

1. Human: download the Stage workspace configuration from Developer Console ("Download all"). Ask for the path of the JSON file.
2. Clone the kit into a folder named for the reader's project (the post uses `order-sync`), then `cd` into it.
3. Run `aio where` and show the human. Continue only on their yes. Then run `aio app use <path-to-Stage-json>`, run `aio where` again, and check it says Stage. `aio app use` writes `.aio` and the Runtime part of `.env`, and it also switches the CLI's global workspace.
4. Run `npm install`.
5. Save the same JSON as `scripts/onboarding/config/workspace.json`. Check `.gitignore` covers it.
6. The kit's `env.dist` lists every variable it expects. Copy those variables into `.env` and leave the values empty. Do not invent values. The groups are:
   - the Commerce base URL;
   - Commerce credentials: OAuth credentials from a Commerce integration on PaaS, or IMS credentials on Adobe Commerce as a Cloud Service (ACCS), as the kit's README for this tag says;
   - the details the onboarding script needs.
7. Human: fill in the values in `.env`. Tip from the post: create a dedicated Commerce integration with only the API resources the app needs. Do not reuse an admin account's access.
8. Read how an event flows through the kit. Each entity and direction has its own folder under `actions/`. Every event passes the same pipeline: validate, transform, send, then pre and post hooks. Keep this pipeline when you add the reader's code. Tell the human what you found.
9. Human yes needed. Run `aio where`, show it, then `aio app deploy`.
10. Human yes needed. Run `aio where`, show it, then `npm run onboard`. The script creates the event provider and the registrations in Developer Console, so nobody clicks them together by hand.
11. Subscribe Commerce to the events the kit listens for. Use the subscribe script the kit's README names for this tag. Ask the human to run it if it needs Commerce access you don't have. Eventing in detail is Ep 6: <https://mageminion.com/app-builder-ep6-commerce-events/>.
12. Ask the human if they want you to commit. Only on their yes, commit the code and `env.dist`. Never commit `.env` or `.aio`. Offer to add a short `README.md` at the top of the repo with the reader's own setup steps.

## Tests
None from this repo.

## Check it works
1. Local: the post gives no local check for this episode. Its checks need a deployed action and a Commerce instance.
2. After the human says yes to the deploy: ask the human to create a test customer in the Commerce admin. Then run `aio app logs`.
3. If nothing shows, ask the human to open the registration's Debug Tracing tab in Developer Console. It lists each delivery with the response code the action returned. On the post's Stage workspace, runs started by I/O Events did not show in `aio rt activation list` or `aio app logs`, but the delivery trace had them. An empty `aio app logs` does not prove the event never arrived.
4. Then check three things in order:
   - Is Commerce connected to the workspace? In the Commerce admin: Stores > Configuration > Adobe Services > Adobe I/O Events.
   - Is the event subscribed? Run `bin/magento events:list` on the Commerce side (ask the human).
   - Does the registration in Developer Console point at the deployed action?

## Names to rename
| In the reference | Why it may differ in yours |
|---|---|
| `order-sync` (project folder) | The post's name for its project. Use the reader's project name. |
| `<project>-Stage.json` | The file name Developer Console gives the download. It depends on the reader's project. |
| the entities and actions under `actions/` | The kit ships a set for each entity and direction. Keep the ones the reader needs. |

## Not in this episode
- Scheduled jobs, State and Files: Ep 3.
- Database Storage: Ep 4.
- Event subscriptions in depth, retries and idempotent handlers: Ep 6.
- The checkout starter kit (payment, shipping and tax webhooks). The post names it but does not use it.
- The kit's `main` branch and `app.commerce.config.ts` (App Management). The post uses the `legacy` tag.
