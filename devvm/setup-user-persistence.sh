#!/usr/bin/env bash
# Provision tmux session persistence (tpm + tmux-resurrect + tmux-continuum)
# for one OS user, so their sessions auto-save and auto-restore when a fresh
# tmux server starts (e.g. after a reboot). Idempotent — safe to re-run.
#
# Run as root:   sudo ./setup-user-persistence.sh <os-user>
#
# Companion to tmux-user-attach: that script keeps a server alive across
# ttyd restarts; this one brings sessions back after the server *does* die
# (reboot / kill). Mirrors wizard's setup so every lobby user is equal.
set -euo pipefail

user="${1:?usage: setup-user-persistence.sh <os-user>}"
home="$(getent passwd "$user" | cut -d: -f6)"
group="$(id -gn "$user")"
[[ -d "$home" ]] || { echo "no home dir for $user" >&2; exit 1; }

plugdir="$home/.tmux/plugins"
declare -A repos=(
  [tpm]=https://github.com/tmux-plugins/tpm
  [tmux-resurrect]=https://github.com/tmux-plugins/tmux-resurrect
  [tmux-continuum]=https://github.com/tmux-plugins/tmux-continuum
)

echo "==> Installing tmux plugins for $user..."
sudo -u "$user" -H mkdir -p "$plugdir"
for name in "${!repos[@]}"; do
  dest="$plugdir/$name"
  if [[ -d "$dest/.git" ]]; then
    sudo -u "$user" -H git -C "$dest" pull --ff-only --quiet || true
  else
    sudo -u "$user" -H git clone --depth 1 --quiet "${repos[$name]}" "$dest"
  fi
done

echo "==> Writing managed block in $home/.tmux.conf..."
conf="$home/.tmux.conf"
begin="# >>> terminal-lobby persistence (managed — do not edit inside) >>>"
end="# <<< terminal-lobby persistence (managed) <<<"
block="$begin
set -g @plugin 'tmux-plugins/tpm'
set -g @plugin 'tmux-plugins/tmux-resurrect'
set -g @plugin 'tmux-plugins/tmux-continuum'
set -g @resurrect-capture-pane-contents 'on'
set -g @continuum-restore 'on'
set -g @continuum-save-interval '5'
run '~/.tmux/plugins/tpm/tpm'
$end"

tmp="$(mktemp)"
# Strip any prior managed block (keeps the user's own lines), then append.
if [[ -f "$conf" ]]; then
  awk -v b="$begin" -v e="$end" '
    $0==b {skip=1}
    $0==e {skip=0; next}
    !skip {print}
  ' "$conf" > "$tmp"
fi
printf '%s\n' "$block" >> "$tmp"
install -o "$user" -g "$group" -m 0644 "$tmp" "$conf"
rm -f "$tmp"

echo "==> Done. $user: resurrect+continuum active on next fresh tmux server."
