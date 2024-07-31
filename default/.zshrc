#!/usr/bin/zsh
# source ~/.fzf.zsh <- for preventing duplicates
autoload -Uz zrecompile

PATH="${HOME}/.local/bin:$PATH"
export STOW_DIR="$HOME/dotfiles"

. $STOW_DIR/functions.sh

# If not in VS Code/Screen/TMUX
if [ -z "$TERM_PROGRAM" ] && [ -z "$STY" ]; then
  run_tmux
fi

(
  gen_completions "tailscale completion zsh" &
  gen_completions "gh completion -s zsh" &
  install_stow &
  install_fzf &
  install_antidote &
) >/dev/null 2>&1
wait

source "$HOME/.antidote/antidote.zsh"
source "$HOME/.fzf.zsh"

antidote load

bind_keys
clear
install_zoxide
