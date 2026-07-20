# ~/.config/fish/config.fish: sourced by fish for interactive shells.
# Load user environment variables from ~/.env and ~/.env.local.

function _load_dotenv --argument-names file
    if test -f "$file"
        for line in (cat "$file")
            # Skip comments and blank lines
            if string match -q -r '^\s*(#|$)' "$line"
                continue
            end

            # Remove optional 'export ' prefix and split on first '='
            set -l kv (string replace -r '^\s*export\s+' '' "$line" | string split -m 1 '=')
            if test (count $kv) -eq 2
                set -l key $kv[1]
                set -l val $kv[2]

                # Strip surrounding quotes
                set val (string replace -r '^"(.*)"$' '$1' "$val")
                set val (string replace -r "^'(.*)'$" '$1' "$val")

                set -gx $key "$val"
            end
        end
    end
end

_load_dotenv "$HOME/.env"
_load_dotenv "$HOME/.env.local"
