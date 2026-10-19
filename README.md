# Dotfiles

## How to use

- Clone repo and use `install.sh` script
- Run `sh -c "$(curl -fsLS get.chezmoi.io/lb)" -- init --apply ThePhaseless`

## Claude Code and omp

Anything installed into Claude Code must also work in omp. omp loads Claude plugins' skills, agents, commands and MCP servers but not their hooks; `home/dot_omp/private_agent/extensions/` holds bridges for the hooks that matter, and the exceptions are listed in `home/dot_claude/CLAUDE.md`.
