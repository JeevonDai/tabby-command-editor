#!/usr/bin/env bash
set -euo pipefail

show_usage() {
    cat <<'EOF'
Usage: ./deploy-to-tabby.sh [options]

Sync tabby-command-editor build output to the current macOS user's Tabby plugin directory.

Options:
  -b, --build              Run npm run build before deploying
  -s, --source PATH        Source root, defaults to this script directory
  -t, --target PATH        Tabby plugin install directory
  -i, --items ITEMS        Comma-separated items to sync, defaults to dist,typings,package.json
  -h, --help               Show this help

Default target:
  ~/Library/Application Support/tabby/plugins/node_modules/tabby-command-editor
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_path="$script_dir"
target_path="$HOME/Library/Application Support/tabby/plugins/node_modules/tabby-command-editor"
items_csv="dist,typings,package.json"
build=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        -b|--build)
            build=true
            shift
            ;;
        -s|--source)
            source_path="${2:?Missing value for $1}"
            shift 2
            ;;
        -t|--target)
            target_path="${2:?Missing value for $1}"
            shift 2
            ;;
        -i|--items)
            items_csv="${2:?Missing value for $1}"
            shift 2
            ;;
        -h|--help)
            show_usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            show_usage >&2
            exit 2
            ;;
    esac
done

source_root="$(cd "$source_path" && pwd)"
target_root="$target_path"

step() {
    printf '=> %s\n' "$1"
}

ok() {
    printf 'OK %s\n' "$1"
}

warn() {
    printf '!! %s\n' "$1"
}

run_build() {
    if [[ ! -f "$source_root/package.json" ]]; then
        echo "package.json not found in $source_root" >&2
        exit 1
    fi

    step "Running npm run build ..."
    (cd "$source_root" && npm run build)
}

sync_item() {
    local item="$1"
    local source_item="$source_root/$item"
    local target_item="$target_root/$item"

    if [[ ! -e "$source_item" ]]; then
        warn "Skipping missing source item: $source_item"
        return
    fi

    mkdir -p "$(dirname "$target_item")"

    if [[ -d "$source_item" ]]; then
        mkdir -p "$target_item"
        rsync -a --delete "$source_item/" "$target_item/"
    else
        cp -f "$source_item" "$target_item"
    fi

    ok "Synced $item"
}

printf '\n'
printf 'tabby-command-editor -> Tabby plugin deploy (macOS)\n'
printf 'Current user : %s\n' "${USER:-unknown}"
printf 'Source dir   : %s\n' "$source_root"
printf 'Target dir   : %s\n' "$target_root"
printf '\n'

if [[ ! -d "$target_root" ]]; then
    cat >&2 <<EOF
Target directory does not exist:
  $target_root

Install the plugin in Tabby first, create the directory manually, or pass --target.
EOF
    exit 1
fi

if [[ "$build" == true ]]; then
    run_build
fi

IFS=',' read -r -a items <<< "$items_csv"
for index in "${!items[@]}"; do
    items[$index]="$(printf '%s' "${items[$index]}" | xargs)"
done

for item in "${items[@]}"; do
    if [[ "$item" == "dist" && ! -d "$source_root/dist" ]]; then
        cat >&2 <<EOF
Build output not found:
  $source_root/dist

Run:
  npm run build
or:
  ./deploy-to-tabby.sh --build
EOF
        exit 1
    fi
done

step "Syncing files ..."
for item in "${items[@]}"; do
    [[ -n "$item" ]] && sync_item "$item"
done

printf '\n'
ok "Deploy complete. Restart Tabby or reload the plugin for changes to take effect."
printf '\n'
