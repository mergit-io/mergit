# Sourced by update.sh. sync_repo <dir> [branch]   (default branch: main)
#
# A deploy host mirrors origin. `git pull --ff-only` fails the day history is rewritten (a force-push, or a rebase that
# was pushed): "Diverging branches can't be fast-forwarded", and then nothing deploys until someone fixes the server by
# hand. So this resets to origin instead, with three safeguards:
#   - it refuses to run over uncommitted edits to tracked files (someone edited the server by hand);
#   - it never touches untracked or ignored files, which is where the secrets live (deploy/secrets/);
#   - it names every local commit it drops (they stay in `git reflog`).
sync_repo() {
  local dir=$1 branch=${2:-main}
  git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || { echo "update: $dir is not a git checkout" >&2; return 1; }
  git -C "$dir" fetch --quiet origin "$branch" || { echo "update: could not fetch origin/$branch for $dir" >&2; return 1; }
  if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]; then
    echo "update: $dir has uncommitted changes to tracked files; commit or discard them first" >&2
    return 1
  fi
  local dropped
  dropped=$(git -C "$dir" log --oneline "origin/$branch..HEAD")
  if [ -n "$dropped" ]; then
    echo "update: $dir has commits that are not on origin/$branch; dropping them (git reflog keeps them):" >&2
    echo "$dropped" >&2
  fi
  git -C "$dir" reset --hard --quiet "origin/$branch"
}
