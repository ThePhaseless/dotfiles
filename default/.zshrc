#!/usr/bin/zsh

if [ -z "$STOW_DIR" ]; then
  export STOW_DIR="$HOME/dotfiles"
fi

git -C "$STOW_DIR" pull

. $STOW_DIR/functions.sh

# If not in VS Code/Screen/TMUX
if [ -z "$TERM_PROGRAM" ] && [ -z "$STY" ]; then
  run_tmux
elif [ -v "$TMUX" ]; then
  bind_keys
fi

if [ ! -f ~/.antidote/antidote.zsh ]; then
  install_antidote
fi

source "$HOME/.antidote/antidote.zsh"
antidote load

smartcache comp docker completion zsh
smartcache comp gh completion -s zsh

clear
