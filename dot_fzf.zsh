# Setup fzf
# ---------
if [[ ! "$PATH" == */home/thephaseless/.fzf/bin* ]]; then
  PATH="${PATH:+${PATH}:}/home/thephaseless/.fzf/bin"
fi

source <(fzf --zsh)
