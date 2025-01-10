# shellcheck disable=2154
true

COMPLETIONS_PATH="$HOME"/.config/zsh/site-functions

gen_completions() {
    mkdir -p "$COMPLETIONS_PATH"
    local command="$1"
    local executable
    executable=$(echo "$command" | cut -d' ' -f1)
    local completion_script="_$executable"
    if [ ! -f "$COMPLETIONS_PATH/$completion_script" ] && command -v "$executable" &>/dev/null; then
        eval "$command" >"$COMPLETIONS_PATH/$completion_script"
    fi
}

update_github_repo() {
    local repo_url=$1
    local output_path=$2

    # Extract repo name
    local repo_name=$(basename "$1" .git)

    # Set default output path
    if [ -z "$output_path" ]; then
        output_path=$HOME/.${repo_name}
    fi

    # Check if repo already exists
    if [ -d "$output_path" ]; then
        git -C "$output_path" pull
    else
        # Clone repo
        git clone "$repo_url" "$output_path"
    fi
}

install_antidote() {
    update_github_repo "https://github.com/mattmc3/antidote.git"
}

run_tmux() {
    # Check if Tmux is installed
    if command -v tmux &>/dev/null; then
        if update_github_repo "https://github.com/gpakosz/.tmux.git"; then
            ln -s -f .tmux/.tmux.conf .
        fi
        # Run tmux
        exec (tmux attach || tmux new)
    else
        echo "tmux is not installed!"
    fi
}

install_stow() {
    if command -v stow &>/dev/null; then
        if update_github_repo "https://github.com/thephaseless/dotfiles.git" "$STOW_DIR"; then
            stow default
        fi
    else
        echo "stow is not installed!"
    fi
}

install_fzf() {
    if update_github_repo "https://github.com/junegunn/fzf.git"; then
        "$HOME"/.fzf/install --all
    fi
}

install_zoxide() {
    if ! command -v zoxide &>/dev/null; then
        curl -sSfL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | sh
    fi
    zoxide init zsh
}

bind_keys() {
    bindkey '^I' menu-select                                          # TAB
    bindkey -M menuselect '^I' menu-complete                          # TAB
    bindkey "${terminfo[kcbt]}" menu-select                           # shift-tab
    bindkey -M menuselect "${terminfo[kcbt]}" reverse-menu-complete   # shift-tab
    bindkey -M menuselect '^[[D' .backward-char '^[OD' .backward-char # arrow left
    bindkey -M menuselect '^[[C' .forward-char '^[OC' .forward-char   # arrow right
}
