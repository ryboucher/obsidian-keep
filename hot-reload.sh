#!/bin/bash
# Hot reload Mini Notes plugin to phone via ADB
# Usage: ./hot-reload.sh [--watch]

export MSYS_NO_PATHCONV=1

PHONE="192.168.1.184:40179"
PHONE_PLUGIN_DIR="/storage/emulated/0/Obsidian Notes/Vault/.obsidian/plugins/obsidian-mini-notes"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

deploy() {
    echo "Building..."
    cd "$LOCAL_DIR" && npm run build 2>&1
    if [ $? -ne 0 ]; then
        echo "BUILD FAILED"
        return 1
    fi

    echo "Pushing to phone..."
    adb -s "$PHONE" push "$LOCAL_DIR/main.js" "$PHONE_PLUGIN_DIR/main.js"
    adb -s "$PHONE" push "$LOCAL_DIR/styles.css" "$PHONE_PLUGIN_DIR/styles.css"
    adb -s "$PHONE" push "$LOCAL_DIR/manifest.json" "$PHONE_PLUGIN_DIR/manifest.json"

    # Touch .hotreload file to trigger hot-reload plugin (if installed)
    adb -s "$PHONE" shell "touch '$PHONE_PLUGIN_DIR/.hotreload'"

    echo "--- Deployed at $(date +%H:%M:%S) ---"
}

# Ensure phone is connected
adb connect "$PHONE" 2>/dev/null

if [ "$1" = "--watch" ]; then
    echo "Watching src/ for changes... (Ctrl+C to stop)"
    deploy
    npx nodemon --watch src --ext ts,css --exec "bash -c 'source $LOCAL_DIR/hot-reload.sh deploy'"
else
    deploy
fi
