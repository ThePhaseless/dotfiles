#!/usr/bin/env bash
# Asynchronous chezmoi updater.
#
#   chezmoi-auto-update.sh          pull the repo and apply it (run by .zshrc)
#   chezmoi-auto-update.sh resolve  settle files that changed both in ~ and in the repo
#
# The update runs without a terminal and never prompts. A target edited in ~
# since chezmoi last wrote it (Claude Code rewrites ~/.claude/settings.json, for
# example) is left alone and listed in $STATE/conflicts; everything else is
# applied. .zshrc prints $STATE/notice and the conflict list at the prompt, and
# `dotfiles-resolve` runs the resolve command.

set -euo pipefail

REPO="${CHEZMOI_REPO_PATH:-$HOME/.local/share/chezmoi}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/chezmoi-auto-update"
LOCKFILE="${CHEZMOI_AUTO_UPDATE_LOCK:-/tmp/chezmoi-auto-update.lock}"

# Never wait for a password or a prompt.
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes}"

mkdir -p "$STATE"

log() { echo "[$(date)] $*"; }

# Write the one-shot message .zshrc shows at the next prompt.
notify() {
    printf '%s\n' "$*" >"$STATE/notice.tmp"
    mv -f "$STATE/notice.tmp" "$STATE/notice"
}

fail() {
    log "$1 failed."
    notify "update failed: $1 (log: $STATE/log)"
    exit 1
}

# `chezmoi status` columns: 1 = target changed since chezmoi last wrote it,
# 2 = what apply would do. Both set means apply would ask before overwriting.
list_conflicts() {
    chezmoi status --no-tty </dev/null |
        awk 'substr($0, 1, 1) != " " && substr($0, 2, 1) != " " { print substr($0, 4) }'
}

# Pending file changes with no local edits, safe to apply unattended. Scripts
# (R) are left for the full apply that runs once nothing conflicts.
list_safe() {
    chezmoi status --no-tty </dev/null |
        awk 'substr($0, 1, 1) == " " && substr($0, 2, 1) != " " && substr($0, 2, 1) != "R" { print substr($0, 4) }'
}

save_conflicts() {
    if [ -n "$1" ]; then
        printf '%s\n' "$1" >"$STATE/conflicts.tmp"
        mv -f "$STATE/conflicts.tmp" "$STATE/conflicts"
    else
        rm -f "$STATE/conflicts"
    fi
}

update() {
    exec 9>"$LOCKFILE"
    if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
        log "Updater already running. Exiting."
        exit 0
    fi

    log "Starting background update..."

    if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
        log "Local uncommitted changes in $REPO. Skipping update."
        notify "update skipped: uncommitted changes in $REPO"
        exit 0
    fi

    local old new conflicts safe count=0 summary=""
    old=$(git -C "$REPO" rev-parse --short HEAD)
    if ! git -C "$REPO" pull --rebase --quiet </dev/null; then
        git -C "$REPO" rebase --abort >/dev/null 2>&1 || true
        fail "git pull"
    fi
    new=$(git -C "$REPO" rev-parse --short HEAD)
    [ "$old" = "$new" ] || summary="pulled $old..$new"

    conflicts=$(list_conflicts)
    if [ -z "$conflicts" ]; then
        count=$(list_safe | grep -c . || true)
        chezmoi apply --no-tty </dev/null || fail "chezmoi apply"
    else
        log "Changed in ~ and in the repo, not applied:"
        sed 's/^/  /' <<<"$conflicts"
        safe=$(list_safe)
        if [ -n "$safe" ]; then
            local targets=() t
            while IFS= read -r t; do targets+=("$HOME/$t"); done <<<"$safe"
            count=${#targets[@]}
            chezmoi apply --no-tty -- "${targets[@]}" </dev/null || fail "chezmoi apply"
        fi
    fi
    save_conflicts "$conflicts"

    [ "$count" -eq 0 ] || summary="${summary:+$summary, }applied $count file(s)"
    [ -z "$summary" ] || notify "updated: $summary"
    log "Update finished${summary:+: $summary}."
}

resolve() {
    if [ ! -t 0 ]; then
        echo "dotfiles-resolve needs a terminal." >&2
        exit 1
    fi

    local conflicts t answer
    conflicts=$(list_conflicts)
    if [ -z "$conflicts" ]; then
        echo "No conflicts."
    fi

    while IFS= read -r t; do
        [ -n "$t" ] || continue
        echo
        echo "== ~/$t changed in ~ and in the repo. Diff: - ~ version, + repo version"
        chezmoi diff --no-pager "$HOME/$t" || true
        while :; do
            read -r -p "[k]eep ~ version (re-add to repo), [r]epo version, [m]erge, [s]kip? " answer </dev/tty
            case "$answer" in
            k)
                if [[ "$(chezmoi source-path "$HOME/$t")" == *.tmpl ]]; then
                    echo "Template source: re-add cannot save it. Use [m]erge."
                    continue
                fi
                chezmoi re-add "$HOME/$t"
                ;;
            r) chezmoi apply --force "$HOME/$t" ;;
            m) chezmoi merge "$HOME/$t" && chezmoi apply --force "$HOME/$t" ;;
            s) ;;
            *) continue ;;
            esac
            break
        done
    done <<<"$conflicts"

    conflicts=$(list_conflicts)
    save_conflicts "$conflicts"
    if [ -z "$conflicts" ]; then
        echo
        echo "Applying the rest..."
        chezmoi apply
    fi
    if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
        echo
        echo "Uncommitted changes in $REPO pause auto-updates until committed:"
        git -C "$REPO" status --short
    fi
}

case "${1:-update}" in
update) update ;;
resolve) resolve ;;
*)
    echo "usage: $0 [update|resolve]" >&2
    exit 2
    ;;
esac
