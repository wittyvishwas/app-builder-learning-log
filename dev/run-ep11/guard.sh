#!/usr/bin/env bash
# Workspace guard for the Ep 11 run: exits non-zero unless the aio context is the test workspace. Run it before every
# command that changes something (`aio app dev`, `aio event ...`, `aio api-mesh:*`, db writes), from anywhere:
#   dev/run-ep11/guard.sh && <command>
# It needs all three of these (values from .env, or the environment; it never prints them):
#   1. `aio where` has a line ending "Project: $MESH_PROJECT_TITLE"
#   2. `aio where` has a line ending "Workspace: $MESH_WORKSPACE_NAME"
#   3. `aio rt property get --namespace`, run in the repo, contains AIO_runtime_namespace
# Modelled on dev/run-ep8/mesh.sh. A bare `aio where && ...` guards nothing, because `aio where` exits 0 in any context.
set -u

die () { echo "guard.sh: $*" >&2; exit 1; }

repo="$(cd "$(dirname "$0")/../.." && pwd)"
envfile="$repo/.env"
read_env () { sed -n "s/^$1=//p" "$envfile" | head -n 1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
for name in MESH_PROJECT_TITLE MESH_WORKSPACE_NAME AIO_runtime_namespace; do
  if [ -z "${!name:-}" ] && [ -f "$envfile" ]; then printf -v "$name" '%s' "$(read_env "$name")"; fi
  [ -n "${!name:-}" ] || die "$name is not set (.env or environment): refusing"
done

# Escape regex characters, trim trailing blanks from the aio lines, then anchor each name at the end of its line.
escape () { printf '%s' "$1" | sed 's#[][\.*^$+?(){}|]#\\&#g'; }
where=$(cd "$repo" && aio where | sed 's/[[:space:]]*$//')
printf '%s\n' "$where" | grep -qE -- "Project: $(escape "$MESH_PROJECT_TITLE")\$" \
  || die "aio where does not show the expected project: refusing (select the context first)"
printf '%s\n' "$where" | grep -qE -- "Workspace: $(escape "$MESH_WORKSPACE_NAME")\$" \
  || die "aio where does not show the expected workspace: refusing (select the context first)"

ns=$(cd "$repo" && aio rt property get --namespace 2>/dev/null) || die "aio rt property get --namespace failed: refusing"
printf '%s\n' "$ns" | grep -qF -- "$AIO_runtime_namespace" \
  || die "the Runtime namespace is not the one in .env (AIO_runtime_namespace): refusing"

echo "guard.sh: ok (project, workspace and Runtime namespace match .env)"
