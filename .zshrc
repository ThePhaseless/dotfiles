#!/usr/bin/bash
# Load zsh-autocomplete
# skip_global_compinit=1z

# Path to your Oh My Zsh installation.
export ZSH="$HOME/.oh-my-zsh"

autoload -Uz zrecompile        # Fix unicode characters
zstyle ':omz:update' mode auto # update automatically without asking

export COMPLETION_WAITING_DOTS="true"

export HIST_STAMPS="dd/mm/yyyy"

export ZSH_THEME="juanghurtado"

# Enable Docker completions stacking
zstyle ':completion:*:*:docker:*' option-stacking yes
zstyle ':completion:*:*:docker-*:*' option-stacking yes

# set PATH so it includes user's private bin if it exists
mkdir "$HOME"/.local/bin -p
PATH="$HOME/.local/bin:$PATH"

if ! command -v tmux &>/dev/null; then
  echo "tmux not installed"
  return 1
fi

# Run only outside of tmux
if [ -n "$PS1" ] && [[ ! "$TERM" =~ screen ]] && [[ ! "$TERM" =~ tmux ]] && [[ -z "$TMUX" ]] && command -v tmux &>/dev/null; then

  # Check for stow
  dotfiles_path=$HOME/.dotfiles
  if command -v stow &>/dev/null; then
    echo "Updating dotfiles..."
    UPDATE_LOG=$(git -C "$dotfiles_path" pull)
    echo "$UPDATE_LOG"
    if ! echo "$UPDATE_LOG" | grep -q "Already up to date."; then
      echo "dotfiles updated, running stow..."
      stow -t "$HOME" -d "$dotfiles_path" .
    fi
  else
    echo "stow is not installed!"
  fi

  # Check for oh-my-zsh
  if [ ! -d "$ZSH" ]; then
    KEEP_ZSHRC=yes RUNZSH=no sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
  fi

  # Check for .oh-my-tmux
  tmux_path=$HOME/.tmux
  if [ ! -d "$tmux_path" ]; then
    git clone https://github.com/gpakosz/.tmux.git "$tmux_path"
    ln -s -f "$tmux_path"/.tmux.conf .
    if [ ! -f "$HOME/.tmux.conf.local" ]; then
      cp "$tmux_path"/.tmux.conf.local .
    fi
  else
    (
      (
        git -C "$tmux_path" pull >/dev/null
      ) &
    )
  fi

  # Check for zoxide
  if ! command -v zoxide &>/dev/null; then
    curl -sSfL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh | sh
  fi

  # Check for .fzf does not exist
  fzf_path=$HOME/.fzf
  if [ ! -d "$fzf_path" ] || ! [ -f "$HOME"/.fzf.zsh ]; then
    echo "fzf not found, installing"
    git clone --depth 1 https://github.com/junegunn/fzf.git "$fzf_path"
    "$fzf_path"/install --all
  else
    (
      (
        if ! git -C "$fzf_path" pull | grep -q "Already up to date."; then
          "$fzf_path"/install --bin
        fi
      ) &
    )
  fi

  # Install antidote
  if [[ ! -d "${HOME}/.antidote" ]]; then
    git clone --depth=1 https://github.com/mattmc3/antidote.git "${HOME}"/.antidote
  fi

  # Launch tmux if not in vscode
  if [[ -z ${VSCODE_INJECTION+x} ]]; then
    exec $(tmux attach || tmux new)
  fi
fi

eval "$(zoxide init zsh)"
[ -f "$HOME"/.fzf.zsh ] && (source ~/.fzf.zsh || source "$HOME"/.fzf.zsh)

source "$HOME"/.antidote/antidote.zsh

completion_path="$HOME"/.oh-my-zsh/completions
mkdir -p "$completion_path"
[ ! -f "$completion_path"/_tailscale ] && tailscale completion zsh >"$completion_path/_tailscale"
[ ! -f "$completion_path"/_gh ] && gh completion -s zsh >"$completion_path/_gh"

antidote load
source "$HOME"/.zsh_plugins.zsh
