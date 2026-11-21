#!/usr/bin/env bash
# Workspace guard for the Ep 11 run: exits non-zero unless the aio context is the test workspace. Run it before every
# command that changes something (`aio app dev`, `aio event ...`, `aio api-mesh:*`, db writes), from anywhere:
#   dev/run-ep11/guard.sh && <command>
# It reads three values from the repo's .env file only (never from the environment, so an exported shell variable
# cannot stand in for them) and never prints them. It needs all of these:
#   1. `aio where` has a line ending "Project: $MESH_PROJECT_TITLE"
#   2. `aio where` has a line ending "Workspace: $MESH_WORKSPACE_NAME"
#   3. `aio rt namespace list --json`, run in the repo with the repo's credentials, asks the Runtime service and
#      lists a namespace exactly equal to AIO_runtime_namespace. (`aio rt property get --namespace` is no check: it
#      only reads the local config, which is what .env feeds.)
# There is no Org line check: .env has no key that holds the org name, so the server-side namespace check (3) is what
# ties the credentials to the workspace. Add an `Org:` match here if such a key is added.
# Modelled on dev/run-ep8/mesh.sh. A bare `aio where && ...` guards nothing, because `aio where` exits 0 in any context.
set -u

die () { echo "guard.sh: $*" >&2; exit 1; }

repo="$(cd "$(dirname "$0")/../.." && pwd)"
envfile="$repo/.env"
[ -f "$envfile" ] || die ".env not found: refusing"
trim () { sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }
read_env () { sed -n "s/^$1=//p" "$envfile" | head -n 1 | trim | sed -e 's/^["'\'']//' -e 's/["'\'']$//' | trim; }
for name in MESH_PROJECT_TITLE MESH_WORKSPACE_NAME AIO_runtime_namespace; do
  printf -v "$name" '%s' "$(read_env "$name")"
  [ -n "${!name}" ] || die "$name is blank or missing in .env: refusing"
done

# Escape regex characters, trim trailing blanks from the aio lines, then anchor each name at the end of its line.
escape () { printf '%s' "$1" | sed 's#[][\.*^$+?(){}|]#\\&#g'; }
where=$(cd "$repo" && aio where | sed 's/[[:space:]]*$//')
printf '%s\n' "$where" | grep -qE -- "Project: $(escape "$MESH_PROJECT_TITLE")\$" \
  || die "aio where does not show the expected project: refusing (select the context first)"
printf '%s\n' "$where" | grep -qE -- "Workspace: $(escape "$MESH_WORKSPACE_NAME")\$" \
  || die "aio where does not show the expected workspace: refusing (select the context first)"

# Server call: the output is a JSON array of namespace names. One name per line, compared exactly.
list=$(cd "$repo" && aio rt namespace list --json 2>/dev/null) || die "aio rt namespace list failed: refusing"
names=$(printf '%s' "$list" | node -e '
let s = ""
process.stdin.on("data", d => { s += d }).on("end", () => {
  try { const a = JSON.parse(s); if (Array.isArray(a)) a.forEach(n => typeof n === "string" && console.log(n.trim())) } catch (e) {}
})') || die "could not read the namespace list: refusing"
ns_ok=0
while IFS= read -r got; do
  if [ -n "$got" ] && [ "$got" = "$AIO_runtime_namespace" ]; then ns_ok=1; fi
done <<< "$names"
if [ "$ns_ok" = 1 ]; then echo "guard.sh: namespace OK"; else die "namespace MISMATCH: refusing"; fi

echo "guard.sh: ok (project, workspace and Runtime namespace match .env)"
