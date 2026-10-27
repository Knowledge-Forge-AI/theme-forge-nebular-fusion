import { CANDIDATE_VERSION, APPLICATION_NAME } from "./platform-targets.mjs";

// Darwin keeps the script under Resources/bin so the bundle seals it as data.
// Linux keeps it beside the GUI. Resolve installed
// symlinks before locating that executable, including Homebrew's bin link.
/**
 * @param {{os?: string} | null | undefined} target
 * @param {{ nativeRuntime?: boolean }} [options]
 * @returns {string}
 */
export function nativeLauncher(target, options = {}) {
  const os = target?.os;
  if (os !== "darwin" && os !== "linux") throw new Error("Native launcher target required");
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Native launcher options must be an object");
  }
  for (const key of Object.keys(options)) {
    if (key !== "nativeRuntime") {
      throw new Error(`Unknown native launcher option: ${key}`);
    }
  }
  const { nativeRuntime = false } = options;
  if (typeof nativeRuntime !== "boolean") {
    throw new Error("Native launcher nativeRuntime option must be a boolean");
  }
  if (nativeRuntime && os !== "linux") {
    throw new Error("Private native runtime launcher is only supported on Linux targets");
  }
  const executableDirectory = os === "darwin" ? "../../MacOS" : ".";
  if (!nativeRuntime) {
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
bin_dir=$(dirname -- "$self")
[ -d "$bin_dir" ] && [ ! -L "$bin_dir" ] || { echo 'tfnf: native launcher directory invalid' >&2; exit 1; }
root=$(CDPATH= cd -P -- "$bin_dir" && pwd)
payload_root=$(dirname -- "$root")
[ -d "$payload_root" ] && [ ! -L "$payload_root" ] || { echo 'tfnf: native payload root invalid' >&2; exit 1; }
gui_dir=$(CDPATH= cd -P -- "$root/${executableDirectory}" && pwd)
gui="$gui_dir/${APPLICATION_NAME}"
[ -f "$gui" ] && [ -x "$gui" ] && [ ! -L "$gui" ] || { echo 'tfnf: native GUI target unavailable' >&2; exit 1; }
for rel_dir in opt opt/nebular-private opt/nebular-private/lib opt/nebular-private/lib/webkit2gtk-4.1 opt/nebular-private/lib/webkit2gtk-4.1/injected-bundle opt/nebular-private/libexec opt/nebular-private/libexec/sandbox opt/nebular-private/libexec/webkit2gtk-4.1; do
  req_dir="$root/../$rel_dir"
  [ -d "$req_dir" ] && [ ! -L "$req_dir" ] || { echo "tfnf: private runtime directory unavailable: $rel_dir" >&2; exit 1; }
done
private_root=$(CDPATH= cd -P -- "$root/../opt/nebular-private" && pwd)
manifest="$payload_root/native-runtime.json"
[ -f "$manifest" ] && [ ! -L "$manifest" ] || { echo 'tfnf: private runtime manifest unavailable' >&2; exit 1; }
for exec_role in libexec/sandbox/bwrap libexec/sandbox/xdg-dbus-proxy libexec/webkit2gtk-4.1/WebKitGPUProcess libexec/webkit2gtk-4.1/WebKitNetworkProcess libexec/webkit2gtk-4.1/WebKitWebProcess; do
  role_path="$private_root/$exec_role"
  [ -f "$role_path" ] && [ -x "$role_path" ] && [ ! -L "$role_path" ] || { echo "tfnf: private runtime executable role unavailable: $exec_role" >&2; exit 1; }
done
for reg_role in lib/libjavascriptcoregtk-4.1.so.0.9.11 lib/libwebkit2gtk-4.1.so.0.19.9 lib/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so; do
  role_path="$private_root/$reg_role"
  [ -f "$role_path" ] && [ ! -L "$role_path" ] || { echo "tfnf: private runtime library role unavailable: $reg_role" >&2; exit 1; }
done
for soname_role in lib/libjavascriptcoregtk-4.1.so.0 lib/libwebkit2gtk-4.1.so.0; do
  role_path="$private_root/$soname_role"
  [ -f "$role_path" ] || { echo "tfnf: private runtime SONAME unavailable: $soname_role" >&2; exit 1; }
done
if [ "\${1-}" = --path ]; then printf '%s\\n' "$gui"; exit 0; fi
for var in $(env | LC_ALL=C sed -n 's/^\\(LD_[A-Za-z0-9_]*\\)=.*/\\1/p; s/^\\(GLIBC_TUNABLES\\)=.*/\\1/p'); do
  unset "$var"
done
unset LD_LIBRARY_PATH LD_PRELOAD LD_AUDIT LD_DEBUG GLIBC_TUNABLES
canonical_webkit="$private_root/lib/libwebkit2gtk-4.1.so.0.19.9"
[ -f "$canonical_webkit" ] && [ ! -L "$canonical_webkit" ] || { echo 'tfnf: canonical WebKit runtime anchor unavailable' >&2; exit 1; }
LD_LIBRARY_PATH="$private_root/lib"
LD_PRELOAD='libwebkit2gtk-4.1.so.0.19.9'
export LD_LIBRARY_PATH LD_PRELOAD
exec "$gui" "$@"
`;
}
