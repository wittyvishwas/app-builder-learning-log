#!/usr/bin/env bash
# Guarded wrapper for every `aio api-mesh:*` command of the Ep 8 run. Run by the owner only, after selecting the test
# project's context (README, "Session start").
#   dev/run-ep8/mesh.sh <create|update> <file>
#   dev/run-ep8/mesh.sh <purge|delete|get|status|describe>
# It refuses (running nothing) unless `aio where` shows the project named in MESH_PROJECT_TITLE (read from .env, or the
# environment; no default, refuses if unset). A bare `aio where && aio api-mesh:...` guards nothing, because `aio where`
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

# The project title is not a default anywhere in the repo: it comes from MESH_PROJECT_TITLE in .env or the environment.
if [ -z "${MESH_PROJECT_TITLE:-}" ] && [ -f "$(dirname "$0")/../../.env" ]; then
  MESH_PROJECT_TITLE=$(sed -n 's/^MESH_PROJECT_TITLE=//p' "$(dirname "$0")/../../.env" | head -n 1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//')
fi
[ -n "${MESH_PROJECT_TITLE:-}" ] || die "MESH_PROJECT_TITLE is not set (.env or environment): refusing"

# Escape regex characters, trim trailing blanks from the aio line, then anchor the title at the end of the line.
escaped=$(printf '%s' "$MESH_PROJECT_TITLE" | sed 's#[][\.*^$+?(){}|]#\\&#g')
if ! aio where | sed 's/[[:space:]]*$//' | grep -qE -- "Project: ${escaped}\$"; then
  die "aio where does not show the expected project: refusing (select the context first)"
fi

case "$cmd" in
  purge) exec aio api-mesh:cache:purge -a ;;
  create|update) exec aio "api-mesh:$cmd" "$1" ;;
  *) exec aio "api-mesh:$cmd" ;;
esac
