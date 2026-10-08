#!/usr/bin/env bash
# Asynchronous chezmoi updater.
#
#   chezmoi-auto-update.sh          pull the repo and apply it (run by .zshrc)
#   chezmoi-auto-update.sh resolve  settle files that changed both in ~ and in the repo
#
# The update runs without a terminal and never prompts. It writes a message for
# .zshrc to show at the prompt only when it changed something in ~, found a
# conflict or skipped because this repo has uncommitted changes; otherwise it
# stays silent and only writes $STATE/log.
#
# A target edited in ~ since chezmoi last wrote it is never overwritten. If the
# repo changed that file too, it is listed in $STATE/conflicts until
# `dotfiles-resolve` settles it; if only ~ changed, it is left alone silently.

set -euo pipefail

# Keep running if the shell that started us exits.
trap '' HUP

REPO="${CHEZMOI_REPO_PATH:-$HOME/.local/share/chezmoi}"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/chezmoi-auto-update"
LOCKFILE="${CHEZMOI_AUTO_UPDATE_LOCK:-/tmp/chezmoi-auto-update.lock}"

# Never wait for a password or a prompt.
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes}"

# Targets that only take effect in a new shell.
SHELL_FILES=" .zshrc .zshenv .zprofile .zsh_plugins.txt .env .env.local .bashrc .bash_profile .profile "

mkdir -p "$STATE"

log() { echo "[$(date)] $*"; }

# Write the message .zshrc shows at the next prompt of every shell started
# before it. Its mtime tells each shell whether it has seen it.
notify() {
    printf '%s\n' "$*" >"$STATE/notice.tmp"
    mv -f "$STATE/notice.tmp" "$STATE/notice"
}

save_conflicts() {
    if [ $# -gt 0 ]; then
        printf '%s\n' "$@" >"$STATE/conflicts.tmp"
        mv -f "$STATE/conflicts.tmp" "$STATE/conflicts"
    else
        rm -f "$STATE/conflicts"
    fi
}

# Did the repo change the source of target $3 between commits $1 and $2?
source_changed() {
    [ "$1" != "$2" ] || return 1
    local src
    src=$(chezmoi source-path "$HOME/$3" 2>/dev/null) || return 0
    # Run git from the file's directory: $REPO and the source path can differ
    # by a symlinked prefix (/home vs /var/home).
    ! git -C "$(dirname "$src")" diff --quiet "$1" "$2" -- "$(basename "$src")"
}

# "~/a, ~/b, ~/c (+2 more)"
list_names() {
    local out="" n=0 t
    for t in "$@"; do
        n=$((n + 1))
        [ $n -le 3 ] && out="${out:+$out, }~/$t"
    done
    [ $n -le 3 ] || out="$out (+$((n - 3)) more)"
    printf '%s' "$out"
}

update() {
    exec 9>"$LOCKFILE"
    if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
        log "Updater already running. Exiting."
        exit 0
    fi

    log "Starting background update..."

    if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
        log "Uncommitted changes in $REPO. Skipping update."
        local tilde='~'
        notify "auto-update paused: uncommitted changes in ${REPO/#$HOME/$tilde}. Commit or stash them to resume."
        exit 0
    fi

    local old new
    old=$(git -C "$REPO" rev-parse HEAD)
    if ! git -C "$REPO" pull --rebase --quiet </dev/null; then
        git -C "$REPO" rebase --abort >/dev/null 2>&1 || true
        log "git pull failed. Skipping update."
        exit 0
    fi
    new=$(git -C "$REPO" rev-parse HEAD)
    [ "$old" = "$new" ] || log "Pulled ${old:0:7}..${new:0:7}."

    local prev="" line x y t
    local -a apply=() conflicts=()
    [ -f "$STATE/conflicts" ] && prev=$(<"$STATE/conflicts")

    # `chezmoi status` columns: 1 = target changed since chezmoi last wrote
    # it, 2 = what apply would do.
    while IFS= read -r line; do
        x=${line:0:1} y=${line:1:1} t=${line:3}
        [ "$y" != " " ] || continue
        if [ "$x" = " " ]; then
            apply+=("$t")
        elif grep -qxF -- "$t" <<<"$prev" || source_changed "$old" "$new" "$t"; then
            conflicts+=("$t")
        else
            log "Kept local edit: ~/$t"
        fi
    done < <(chezmoi status --no-tty </dev/null)

    save_conflicts ${conflicts[@]+"${conflicts[@]}"}
    [ ${#conflicts[@]} -eq 0 ] || log "Changed in ~ and in the repo, not applied: ${conflicts[*]}"

    if [ ${#apply[@]} -eq 0 ]; then
        log "Nothing to apply."
        exit 0
    fi

    local -a targets=()
    local restart=""
    for t in "${apply[@]}"; do
        targets+=("$HOME/$t")
        case "$SHELL_FILES" in *" $t "*) restart=1 ;; esac
    done

    if ! chezmoi apply --no-tty -- "${targets[@]}" </dev/null; then
        log "chezmoi apply failed."
        notify "update failed while applying $(list_names "${apply[@]}"). See $STATE/log"
        exit 1
    fi

    log "Applied: ${apply[*]}"
    local them=them
    [ ${#apply[@]} -gt 1 ] || them=it
    if [ -n "$restart" ]; then
        notify "updated $(list_names "${apply[@]}"). Restart the shell to load $them: exec zsh"
    else
        notify "updated $(list_names "${apply[@]}"). Restart apps that use $them to load the changes."
    fi
}

resolve() {
    if [ ! -t 0 ]; then
        echo "dotfiles-resolve needs a terminal." >&2
        exit 1
    fi

    local t answer
    local -a conflicts=() left=()
    if [ -s "$STATE/conflicts" ]; then
        while IFS= read -r t; do [ -n "$t" ] && conflicts+=("$t"); done <"$STATE/conflicts"
    fi
    if [ ${#conflicts[@]} -eq 0 ]; then
        echo "No conflicts."
        return 0
    fi

    for t in "${conflicts[@]}"; do
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
            s) left+=("$t") ;;
            *) continue ;;
            esac
            break
        done
    done

    save_conflicts ${left[@]+"${left[@]}"}
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
