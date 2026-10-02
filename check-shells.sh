#!/bin/sh
# Checks that zsh, bash and sh (login, interactive, plain, script) get the same PATH,
# env vars and binaries from ~/.env, starting from a clean environment.
# Usage: sh check-shells.sh   CHECK_EXTRA_VARS="FOO BAR" adds machine-specific vars.
# Prints PASS and exits 0 when every shell agrees.
SYS_PATH=$(env -i HOME="$HOME" bash --noprofile --norc -c '. /etc/profile >/dev/null 2>&1; printf %s "$PATH"')
VARS="EDITOR LANG HOMEBREW_PREFIX BASH_ENV VIRTUAL_ENV_DISABLE_PROMPT ${CHECK_EXTRA_VARS:-}"
TMP=$(mktemp -d)

cat > "$TMP/probe.sh" <<'EOF'
# `command -v` returns shell functions (mise is one once activated); walk PATH for the binary instead.
bin() { printf '%s\n' "$PATH" | tr : '\n' | while read -r d; do [ -x "$d/$1" ] && { printf '%s' "$d/$1"; break; }; done; }
norm() { sed -E 's#^.*/mise/(installs|shims)/([^/]+).*#mise:\2#'; }
# mise install dirs and antidote plugin bins (~/.cache or ~/Library/Caches) exist only in interactive zsh by design.
printf '%s\n' "$PATH" | tr : '\n' | grep -v '/mise/installs/' | grep -v '/antidote/' | grep -v '^$' > "$_CHECK_OUT.path"
dups=$(printf '%s\n' "$PATH" | tr : '\n' | grep -v '^$' | sort | uniq -d | tr '\n' ' ')
{
  for c in screen jq mise python3 node go bun brew; do printf '%s=%s\n' "$c" "$(bin "$c" | norm)"; done
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
run zsh-login   zsh -lic ". $P"
run zsh-inter   zsh -ic  ". $P"
run zsh-plain   zsh -c   ". $P"
run bash-login  bash -lc ". $P"
run bash-inter  bash -ic ". $P"
run bash-script zsh -lc  "bash $P"
run sh-login    sh -lc   ". $P"

fail=0
ref=zsh-login
for n in zsh-login zsh-inter zsh-plain bash-login bash-inter bash-script sh-login; do
  [ -f "$TMP/$n.env" ] || { echo "FAIL $n: probe did not run"; fail=1; continue; }
  if ! diff -q "$TMP/$ref.path" "$TMP/$n.path" >/dev/null; then echo "FAIL $n: PATH differs from $ref"; diff "$TMP/$ref.path" "$TMP/$n.path" | grep '^[<>]' | head -8 | sed 's/^/    /'; fail=1; fi
  if ! diff -q "$TMP/$ref.env" "$TMP/$n.env" >/dev/null; then echo "FAIL $n: env/commands differ from $ref"; diff "$TMP/$ref.env" "$TMP/$n.env" | grep '^[<>]' | sed 's/^/    /'; fail=1; fi
  grep -q '^dups=.' "$TMP/$n.env" && { echo "FAIL $n: duplicate PATH entries: $(sed -n 's/^dups=//p' "$TMP/$n.env")"; fail=1; }
  for d in $(printf '%s' "$SYS_PATH" | tr : ' '); do grep -qx "$d" "$TMP/$n.path" || { echo "FAIL $n: lost system dir $d"; fail=1; }; done
done
echo "--- reference ($ref)"; grep -v '^dups=' "$TMP/$ref.env"; echo "PATH:"; sed 's/^/  /' "$TMP/$ref.path"
rm -rf "$TMP"
[ $fail -eq 0 ] && echo "PASS: all 7 shells agree" || echo "RESULT: FAIL"
exit $fail
