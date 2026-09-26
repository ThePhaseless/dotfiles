# Dotfiles (chezmoi source)

This directory is the chezmoi **source**. Files in `~` are generated **targets**. Make every change here, then apply it; an edit made directly in `~` is lost on the next apply.

## Changing something

1. Edit the source file (see the name map below).
2. For shell files, run `zsh -n <file>` (or `sh -n` for `dot_env.tmpl` after `chezmoi execute-template < dot_env.tmpl`).
3. Run `chezmoi diff <target>` and confirm only your change shows up.
4. Run `chezmoi apply <target>` — always with explicit targets, see "Target drift".
5. Verify in a fresh shell: `env -u DOTENV_LOADED zsh -i -c '<check>'`. Done when the check prints the expected value in that fresh shell.

Source name → target: `dot_x` → `~/.x`, `executable_` sets +x, `.tmpl` is a Go template (data from `.chezmoi.toml.tmpl`, helpers like `lookPath`), `create_` writes the target once and never overwrites it. Repo-only files (this one, `README.md`, `install.sh`) are listed in `.chezmoiignore`; add any new repo-only file there too.

## Where a setting belongs

| Setting | File | Loaded by |
| --- | --- | --- |
| Env var for every shell and script | `dot_env.tmpl` → `~/.env` | `.zshenv` (all zsh), `.bash_profile` + `BASH_ENV` (all bash, including non-interactive scripts) |
| Machine-specific value or secret | `~/.env.local` (untracked) | sourced at the end of `~/.env` |
| Interactive zsh only (prompt, completions, hooks, keybinds) | `executable_dot_zshrc` | interactive zsh |
| zsh plugins | `dot_zsh_plugins.txt` | antidote, rebuilt when the file is newer than `~/.zsh_plugins.zsh` |

Rules for `~/.env`:

- Plain POSIX `sh`: bash, zsh and `sh` source it directly; any other shell can import it with `sh -c '. ~/.env; env -0'`.
- `DOTENV_LOADED` (unexported) makes re-sourcing in the same shell a no-op; child shells load it fresh.
- Secrets and API keys go only in `~/.env.local`, which chezmoi creates from `create_dot_env.local.tmpl` once and never tracks. Edit `~/.env.local` directly.

## Target drift

Tool installers (rustup, brew, etc.) append lines to targets such as `~/.zshenv` or `~/.bash_profile`. A bare `chezmoi apply` reverts them. Run `chezmoi diff` first; when it shows lines you did not write, port them into the source file (or `~/.env` / `~/.env.local`) before applying everything.

## Auto-update and git

- `.zshrc` runs `chezmoi-auto-update.sh` in the background at most hourly. It runs `chezmoi update --apply` only when this repo is clean, so uncommitted work here pauses updates on this machine.
- `chezmoi add` / `chezmoi edit` auto-commit and auto-push (see `.chezmoi.toml.tmpl`). When editing files here directly, commit with plain `git` once the user asks.

## Machine quirks

- `/home` is a symlink to `/var/home`. `$PWD`, `$HOME` and paths baked into tools can differ by that prefix; compare paths resolved (`${path:A}` in zsh, `realpath` elsewhere).

## Python venvs

`autovenv` in `.zshrc` activates the nearest `.venv` above `$PWD` on every `cd` and deactivates it when leaving. A venv activated by hand stays active. `VIRTUAL_ENV_DISABLE_PROMPT=1` in `~/.env` keeps the `(.venv)` prefix out of the prompt.
