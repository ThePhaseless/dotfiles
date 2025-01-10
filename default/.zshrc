#!/usr/bin/zsh
export PATH="${HOME}/.local/bin:$PATH"

if [ -z "$STOW_DIR" ]; then
  export STOW_DIR="$HOME/dotfiles"
fi

. $STOW_DIR/functions.sh

# If not in VS Code/Screen/TMUX
if [ -z "$TERM_PROGRAM" ] && [ -z "$STY" ]; then
  run_tmux
fi
if [ -v "$TMUX" ]; then
  bind_keys
fi

install_antidote
source "$HOME/.antidote/antidote.zsh"

antidote load

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh -

clear
