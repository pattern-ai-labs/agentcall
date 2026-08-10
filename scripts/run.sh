#!/bin/bash
# Runtime detection — dispatch to whichever runtime is actually usable,
# not just whichever binary happens to be first on PATH.
#
# PATH presence alone isn't proof a runtime works:
#   - a system python3 can exist without aiohttp/websockets installed,
#     surfacing as a ModuleNotFoundError deep inside join.py
#   - on Windows, `python3` frequently resolves to the WindowsApps App
#     Execution Alias stub rather than a real interpreter, and fails the
#     moment it's asked to import anything
# So each candidate is checked for the specific import/module it needs
# before being trusted, with Python preferred when both work.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

python_ok() {
    command -v python3 &>/dev/null && python3 -c "import aiohttp, websockets" &>/dev/null
}

node_ok() {
    command -v node &>/dev/null && [ -d "$SCRIPT_DIR/node/node_modules/ws" ]
}

if python_ok; then
    exec python3 "$SCRIPT_DIR/python/join.py" "$@"
elif node_ok; then
    exec node "$SCRIPT_DIR/node/join.js" "$@"
else
    echo "Error: no working Python or Node.js runtime found." >&2
    if command -v python3 &>/dev/null; then
        echo "  python3 is on PATH but missing deps — run: pip install -r $SCRIPT_DIR/python/requirements.txt" >&2
    fi
    if command -v node &>/dev/null; then
        echo "  node is on PATH but missing deps — run: npm install --prefix $SCRIPT_DIR/node" >&2
    fi
    if ! command -v python3 &>/dev/null && ! command -v node &>/dev/null; then
        echo "  neither python3 nor node was found on PATH" >&2
    fi
    exit 1
fi
