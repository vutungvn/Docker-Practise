#!/usr/bin/env bash
# Roll an environment back to an earlier image (see ROLLBACK.md).
#
#   rollback.sh <staging|production> [commit-sha]
#
# Without a sha it goes back to the version that ran before the current one.
source "$(dirname "$0")/lib.sh"
TARGET=${2:-$(state_get previous)}
[ -n "$TARGET" ] || fail "no previous version recorded for $ENV_NAME - pass a commit sha explicitly"

log "rollback requested -> $TARGET"
"$(dirname "$0")/deploy.sh" "$ENV_NAME" "$TARGET" --rollback
log "rollback finished in $(elapsed)s"
gh_output total "$(elapsed)"
