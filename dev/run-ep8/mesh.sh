#!/usr/bin/env bash
# Guarded wrapper for every `aio api-mesh:*` command of the Ep 8 run. Run by the owner only, after selecting the test
# project's context (README, "Session start").
#   dev/run-ep8/mesh.sh <create|update> <file>
#   dev/run-ep8/mesh.sh <purge|delete|get|status|describe>
# It refuses (running nothing) unless `aio where` shows the project named in MESH_PROJECT_TITLE and the workspace named
# in MESH_WORKSPACE_NAME (both read from .env, or the environment; no default, refuses if either is unset). A bare `aio where && aio api-mesh:...` guards nothing, because `aio where`
# exits 0 in any context. `purge` runs `aio api-mesh:cache:purge -a` and never passes -c (the CLI asks, you answer).
# No other flags pass through.
set -u

die () { echo "mesh.sh: $*" >&2; exit 1; }

cmd=${1:-}
[ $# -ge 1 ] || die "usage: mesh.sh <create|update> <file> | <purge|delete|get|status|describe>"
shift
case "$cmd" in
  create|update) [ $# -eq 1 ] || die "$cmd needs exactly one file argument" ;;
  purge|delete|get|status|describe) [ $# -eq 0 ] || die "$cmd takes no arguments" ;;
  *) die "unknown command: $cmd" ;;
esac

# Neither the project title nor the workspace name is a default anywhere in the repo: they come from MESH_PROJECT_TITLE
# and MESH_WORKSPACE_NAME in .env or the environment.
envfile="$(dirname "$0")/../../.env"
read_env () { sed -n "s/^$1=//p" "$envfile" | head -n 1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
if [ -z "${MESH_PROJECT_TITLE:-}" ] && [ -f "$envfile" ]; then MESH_PROJECT_TITLE=$(read_env MESH_PROJECT_TITLE); fi
if [ -z "${MESH_WORKSPACE_NAME:-}" ] && [ -f "$envfile" ]; then MESH_WORKSPACE_NAME=$(read_env MESH_WORKSPACE_NAME); fi
[ -n "${MESH_PROJECT_TITLE:-}" ] || die "MESH_PROJECT_TITLE is not set (.env or environment): refusing"
[ -n "${MESH_WORKSPACE_NAME:-}" ] || die "MESH_WORKSPACE_NAME is not set (.env or environment): refusing"

# Escape regex characters, trim trailing blanks from the aio lines, then anchor each name at the end of its line.
escape () { printf '%s' "$1" | sed 's#[][\.*^$+?(){}|]#\\&#g'; }
where=$(aio where | sed 's/[[:space:]]*$//')
if ! printf '%s\n' "$where" | grep -qE -- "Project: $(escape "$MESH_PROJECT_TITLE")\$"; then
  die "aio where does not show the expected project: refusing (select the context first)"
fi
if ! printf '%s\n' "$where" | grep -qE -- "Workspace: $(escape "$MESH_WORKSPACE_NAME")\$"; then
  die "aio where does not show the expected workspace: refusing (select the context first)"
fi

case "$cmd" in
  purge) exec aio api-mesh:cache:purge -a ;;
  create|update) exec aio "api-mesh:$cmd" "$1" ;;
  *) exec aio "api-mesh:$cmd" ;;
esac
