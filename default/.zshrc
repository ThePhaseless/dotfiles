#!/usr/bin/zsh

COMPLETIONS_PATH="$HOME"/.config/zsh/site-functions
PATH="/root/.local/bin:$PATH"
export STOW_DIR="$HOME/.dotfiles"

update_github_repo() {
  local repo_url=$1
  local output_path=$2

  # Extract repo name
  local repo_name=${repo_url%%.git}
  repo_name=${repo_name##*/}
  repo_name=${repo_name#\.}

  # Set default output path
  if [ -z "$output_path" ]; then
    output_path=$HOME/.${repo_name}
  fi

  # Check if repo already exists
  if [ -d "$output_path" ]; then
    return "git -C "$output_path" pull --depth 1  >/dev/null 2>&1"
  else
    # Clone repo
    return "$(! git clone --depth 1 "$repo_url" "$output_path" >/dev/null 2>&1)"
  fi
  return 0
}

gen_completions() {
  local command="$1"
  local executable=$(echo "$command" | cut -d' ' -f1)
  local completion_script="_$executable"
  if [ ! -f "$COMPLETIONS_PATH/$completion_script" ] && command -v "$executable" &>/dev/null; then
    eval $command >"$COMPLETIONS_PATH/$completion_script"
  fi
}

# If not in VS Code/Screen/TMUX
if [ -z "$TERM_PROGRAM" ] && [ -z "$STY" ]; then
  # Check if Tmux is installed
  if command -v tmux &>/dev/null; then
    if update_github_repo "https://github.com/gpakosz/.tmux.git"; then
      ln -s -f .tmux/.tmux.conf .
    fi
    # Run tmux
    exec $(tmux attach || tmux new)
  else
    echo "tmux is not installed!"
  fi
fi

# STOW
if command -v stow &>/dev/null; then
  if update_github_repo "https://github.com/thephaseless/dotfiles.git"; then
    stow default
  fi
else
  echo "stow is not installed!"
  return 1
fi

# FZF
if update_github_repo "https://github.com/junegunn/fzf.git"; then
  "$HOME"/.fzf/install --all
fi
# source ~/.fzf.zsh <- for preventing duplicates
# shellcheck source=/dev/null
source "$HOME/.fzf.zsh"

# COMPLETIONS
mkdir -p "$COMPLETIONS_PATH"
gen_completions "tailscale completion zsh"
gen_completions "gh completion -s zsh"

# ANTIDOTE (Must be at the end)
update_github_repo "https://github.com/mattmc3/antidote.git"
# shellcheck source=/dev/null
source "$HOME"/.antidote/antidote.zsh
antidote load

# ZOXIDE
if ! command -v zoxide &>/dev/null; then
  curl -sSfL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | sh
fi
# # shellcheck source=/dev/null
eval "$(zoxide init zsh)"
