#!/bin/sh
# Checks that zsh, bash and sh (login, interactive, plain, scripts) get the same PATH,
# env vars and binaries from ~/.env and mise, starting from a clean environment.
# Usage: sh check-shells.sh   CHECK_EXTRA_VARS="FOO BAR" adds machine-specific vars.
# Also checks ~/.local/bin precedes mise, and that a dir a parent put in front (a venv)
# stays in front in child shells and scripts.
# Prints PASS and exits 0 when every shell agrees.
SYS_PATH=$(env -i HOME="$HOME" bash --noprofile --norc -c '. /etc/profile >/dev/null 2>&1; printf %s "$PATH"')
VARS="EDITOR LANG HOMEBREW_PREFIX BASH_ENV VIRTUAL_ENV_DISABLE_PROMPT GOROOT ${CHECK_EXTRA_VARS:-}"
TMP=$(mktemp -d)

cat > "$TMP/probe.sh" <<'EOF'
# `command -v` returns shell functions (mise is one once activated); walk PATH for the binary instead.
bin() { printf '%s\n' "$PATH" | tr : '\n' | while read -r d; do [ -x "$d/$1" ] && { printf '%s' "$d/$1"; break; }; done; }
# antidote plugin bins (~/.cache or ~/Library/Caches) exist only in interactive zsh by design.
printf '%s\n' "$PATH" | tr : '\n' | grep -v '/antidote/' | grep -v '^$' > "$_CHECK_OUT.path"
dups=$(printf '%s\n' "$PATH" | tr : '\n' | grep -v '^$' | sort | uniq -d | tr '\n' ' ')
{
  for c in screen jq mise python3 node go bun brew; do printf '%s=%s\n' "$c" "$(bin "$c")"; done
  printf '%s\n' "$_CHECK_VARS" | tr ' ' '\n' | grep -v '^$' | while read -r v; do eval "printf '%s=%s\n' $v \"\${$v}\""; done
  printf 'dups=%s\n' "$dups"
} > "$_CHECK_OUT.env"
EOF

# cd "$TMP": autovenv (interactive zsh) would otherwise activate a .venv above the caller's cwd.
run() {
  name=$1; shift
  (cd "$TMP" && env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" TERM=xterm-256color PATH="$SYS_PATH" \
    _CHECK_OUT="$TMP/$name" _CHECK_VARS="$VARS" "$@" >/dev/null 2>&1 </dev/null)
}
P="$TMP/probe.sh"
FAKE="$TMP/venv/bin"
mkdir -p "$FAKE" && printf '#!/bin/sh\n' > "$FAKE/python3" && chmod +x "$FAKE/python3"
run zsh-login   zsh -lic ". $P"
run zsh-inter   zsh -ic  ". $P"
run zsh-plain   zsh -c   ". $P"
run bash-login  bash -lc ". $P"
run bash-inter  bash -ic ". $P"
run bash-script zsh -lc  "bash $P"
run sh-login    sh -lc   ". $P"
run script-from-zsh-inter  zsh -ic  "bash $P"
run script-from-bash-inter bash -ic "bash $P"
run venv-bash-script zsh -lc "PATH=$FAKE:\$PATH bash $P"
run venv-zsh-plain   zsh -lc "PATH=$FAKE:\$PATH zsh -c '. $P'"

fail=0
ref=zsh-login
NAMES="zsh-login zsh-inter zsh-plain bash-login bash-inter bash-script sh-login script-from-zsh-inter script-from-bash-inter"
for n in $NAMES; do
  [ -f "$TMP/$n.env" ] || { echo "FAIL $n: probe did not run"; fail=1; continue; }
  if ! diff -q "$TMP/$ref.path" "$TMP/$n.path" >/dev/null; then echo "FAIL $n: PATH differs from $ref"; diff "$TMP/$ref.path" "$TMP/$n.path" | grep '^[<>]' | head -8 | sed 's/^/    /'; fail=1; fi
  if ! diff -q "$TMP/$ref.env" "$TMP/$n.env" >/dev/null; then echo "FAIL $n: env/commands differ from $ref"; diff "$TMP/$ref.env" "$TMP/$n.env" | grep '^[<>]' | sed 's/^/    /'; fail=1; fi
  grep -q '^dups=.' "$TMP/$n.env" && { echo "FAIL $n: duplicate PATH entries: $(sed -n 's/^dups=//p' "$TMP/$n.env")"; fail=1; }
  for d in $(printf '%s' "$SYS_PATH" | tr : ' '); do grep -qx "$d" "$TMP/$n.path" || { echo "FAIL $n: lost system dir $d"; fail=1; }; done
  lb=$(grep -nx "$HOME/.local/bin" "$TMP/$n.path" | cut -d: -f1); mi=$(grep -n "^$HOME/.local/share/mise/" "$TMP/$n.path" | head -1 | cut -d: -f1)
  [ -n "$lb" ] && [ -n "$mi" ] && [ "$lb" -gt "$mi" ] && { echo "FAIL $n: ~/.local/bin (#$lb) after mise (#$mi)"; fail=1; }
done
for n in venv-bash-script venv-zsh-plain; do
  [ "$(head -1 "$TMP/$n.path" 2>/dev/null)" = "$FAKE" ] && grep -qx "python3=$FAKE/python3" "$TMP/$n.env" || { echo "FAIL $n: parent's venv no longer first (first=$(head -1 "$TMP/$n.path" 2>/dev/null), $(grep '^python3=' "$TMP/$n.env" 2>/dev/null))"; fail=1; }
done
echo "--- reference ($ref)"; grep -v '^dups=' "$TMP/$ref.env"; echo "PATH:"; sed 's/^/  /' "$TMP/$ref.path"
rm -rf "$TMP"
[ $fail -eq 0 ] && echo "PASS: all $(echo $NAMES | wc -w) shells agree; venv stays first in 2 child kinds" || echo "RESULT: FAIL"
exit $fail
