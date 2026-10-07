# Dotfiles (chezmoi source)

This directory is the chezmoi **source**. Files in `~` are generated **targets**. Make every change here, then apply it; an edit made directly in `~` is lost on the next apply.

## Changing something

1. Edit the source file (see the name map below).
2. For shell files, run `zsh -n <file>` (or `sh -n` for `dot_env.tmpl` after `chezmoi execute-template < dot_env.tmpl`).
3. Run `chezmoi diff <target>` and confirm only your change shows up.
4. Run `chezmoi apply <target>` — always with explicit targets, see "Target drift".
5. Verify in a fresh shell: `env -u DOTENV_LOADED zsh -i -c '<check>'`. Done when the check prints the expected value in that fresh shell. For PATH or `~/.env` changes, done when `sh check-shells.sh` prints `PASS` on every machine you can reach.

Source name → target: `dot_x` → `~/.x`, `executable_` sets +x, `.tmpl` is a Go template (data from `.chezmoi.toml.tmpl`, helpers like `lookPath`), `create_` writes the target once and never overwrites it. The source state lives in `home/` (set by `.chezmoiroot`); every source name in this file is relative to it. Repo-only files (this one, `README.md`, `install.sh`, `check-shells.sh`, `chezmoi-auto-update.sh`) sit at the repo root, outside `home/`, so they are never applied. `home/.chezmoiignore` guards target paths that must never be tracked.

## Where a setting belongs

| Setting | File | Loaded by |
| --- | --- | --- |
| Env var or PATH entry for every shell and script | `dot_env.tmpl` → `~/.env` | `.zshenv` (all zsh), `.zprofile` (login zsh), `.bash_profile` / `.bashrc` / `BASH_ENV` (all bash), `.profile` (login sh) |
| Machine-specific value, PATH entry or secret | `~/.env.local` (untracked) | sourced at the end of `~/.env` |
| Shell loaders | `dot_zshenv`, `dot_zprofile`, `dot_profile`, `dot_bash_profile`, `dot_bashrc` | the shell; each only sources `~/.env` (plus `/etc/bashrc`, `~/.bashrc`) |
| Interactive zsh only (prompt, completions, hooks, keybinds) | `executable_dot_zshrc` | interactive zsh |
| zsh plugins | `dot_zsh_plugins.txt` | antidote, rebuilt when the file is newer than `~/.zsh_plugins.zsh` |
| Agent guide for working anywhere in `~` | `AGENTS.md` → `~/AGENTS.md` (`CLAUDE.md` imports it) | Claude Code (walks up to `~`), omp outside git repos |
| Claude Code settings and global instructions | `dot_claude/settings.json`, `dot_claude/CLAUDE.md` | Claude Code; omp also reads `~/.claude/CLAUDE.md` and Claude plugins |
| omp settings | `dot_omp/private_agent/private_config.yml` | omp |

Rules for `~/.env`:

- Plain POSIX `sh`: bash, zsh and `sh` source it directly; any other shell can import it with `sh -c '. ~/.env; env -0'`.
- `DOTENV_LOADED` (unexported) makes re-sourcing in the same shell a no-op; child shells load it fresh.
- Every PATH entry goes through `_dotenv_path_prepend` (also usable in `~/.env.local`): it skips missing dirs and moves an existing entry to the front, so re-sourcing never duplicates. The list in `dot_env.tmpl` runs lowest priority first.
- Secrets and API keys go only in `~/.env.local`, which chezmoi creates from `create_dot_env.local.tmpl` once and never tracks. Edit `~/.env.local` directly.

## PATH order and mise

Every shell resolves in this order: whatever a parent put in front (venv, `node_modules/.bin`) → `~/.local/bin` → mise tools, Homebrew and the other `~` tool dirs → OS dirs.

- PATH and mise are set up once per environment: `~/.env` exports `DOTENV_PATH=1`, and children keep the PATH they inherit. `.zprofile`, `.bash_profile` and `.profile` unset it to rebuild after `/etc/profile`, whose macOS `path_helper` puts system dirs back in front.
- Interactive bash/zsh run `mise activate` from their rc file; any other shell that builds PATH gets `mise hook-env --force` from `~/.env`. `MISE_ACTIVATE_AGGRESSIVE=1` stops `activate` from ranking earlier PATH edits above mise's tools — mise does that only in a terminal.
- `_dotenv_local_bin_first` moves `~/.local/bin` just ahead of mise's first dir; `.zshrc` and `.bashrc` rerun it after mise's prompt and cd hooks.
- Tool order in `~/.config/mise/config.toml` is PATH order: a tool whose bin dir bundles another tool's binary (cursor-agent ships `node`) goes last.
- `check-shells.sh` runs without a terminal. After changing PATH or mise setup, also open a real terminal and compare `command -v node python3` in zsh and bash, at the prompt and after `cd` into a project with a mise config.

## Target drift

Tool installers (rustup, brew, etc.) append lines to targets such as `~/.zshenv` or `~/.bash_profile`. A bare `chezmoi apply` reverts them. Run `chezmoi diff` first; when it shows lines you did not write, port them into the source file (or `~/.env` / `~/.env.local`) before applying everything.

## Auto-update and git

- `.zshrc` runs `chezmoi-auto-update.sh` in the background at most hourly. It runs `chezmoi update --apply` only when this repo is clean, so uncommitted work here pauses updates on this machine.
- `chezmoi add` / `chezmoi edit` auto-commit and auto-push (see `.chezmoi.toml.tmpl`). When editing files here directly, commit with plain `git` once the user asks.

## Machine quirks

- `/home` is a symlink to `/var/home`. `$PWD`, `$HOME` and paths baked into tools can differ by that prefix; compare paths resolved (`${path:A}` in zsh, `realpath` elsewhere).

## Python venvs

`autovenv` in `.zshrc` activates the nearest `.venv` above `$PWD` on every `cd` and deactivates it when leaving. A venv activated by hand stays active. `VIRTUAL_ENV_DISABLE_PROMPT=1` in `~/.env` keeps the `(.venv)` prefix out of the prompt.
