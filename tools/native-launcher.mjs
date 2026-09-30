import { CANDIDATE_VERSION, APPLICATION_NAME } from "./platform-targets.mjs";

// Darwin keeps the script under Resources/bin so the bundle seals it as data.
// Linux keeps it beside the GUI. Resolve installed
// symlinks before locating that executable, including Homebrew's bin link.
export function nativeLauncher(target) {
  if (!["darwin", "linux"].includes(target?.os)) throw new Error("Native launcher target required");
  const executableDirectory = target.os === "darwin" ? "../../MacOS" : ".";
  return `#!/bin/sh
set -eu
case "\${1-}" in
  --version|-v) printf '%s\\n' '${APPLICATION_NAME} ${CANDIDATE_VERSION}'; exit 0 ;;
  --help|-h) printf '%s\\n' 'Usage: tfnf [--version|--help|--path]'; exit 0 ;;
esac
self=$0
case "$self" in /*) ;; *) self="$PWD/$self" ;; esac
links=0
while [ -L "$self" ]; do
  links=$((links + 1))
  [ "$links" -le 40 ] || { echo 'tfnf: launcher symlink cycle' >&2; exit 1; }
  parent=$(CDPATH= cd -P -- "$(dirname -- "$self")" && pwd)
  link=$(readlink "$self")
  case "$link" in /*) self=$link ;; *) self="$parent/$link" ;; esac
done
root=$(CDPATH= cd -P -- "$(dirname -- "$self")" && pwd)
gui_dir=$(CDPATH= cd -P -- "$root/${executableDirectory}" && pwd)
gui="$gui_dir/${APPLICATION_NAME}"
[ -f "$gui" ] && [ -x "$gui" ] && [ ! -L "$gui" ] || { echo 'tfnf: native GUI target unavailable' >&2; exit 1; }
if [ "\${1-}" = --path ]; then printf '%s\\n' "$gui"; exit 0; fi
exec "$gui" "$@"
`;
}
