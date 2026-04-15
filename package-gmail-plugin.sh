#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_PLUGIN_DIR="${SCRIPT_DIR}/com.delda.gmail.sdPlugin"
MANIFEST_PATH="${SOURCE_PLUGIN_DIR}/manifest.json"
SKIP_DEPENDENCY_INSTALL="${SKIP_DEPENDENCY_INSTALL:-0}"

if [[ ! -d "${SOURCE_PLUGIN_DIR}" ]]; then
    echo "Cartella plugin non trovata: ${SOURCE_PLUGIN_DIR}" >&2
    exit 1
fi

if [[ ! -f "${MANIFEST_PATH}" ]]; then
    echo "Manifest non trovato: ${MANIFEST_PATH}" >&2
    exit 1
fi

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js e' richiesto per leggere il manifest del plugin." >&2
    exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
    echo "Il comando zip e' richiesto per creare il pacchetto finale." >&2
    exit 1
fi

PLUGIN_UUID="$(
    node -e "const manifest = require(process.argv[1]); if (!manifest.UUID) { process.exit(1); } process.stdout.write(manifest.UUID);" "${MANIFEST_PATH}"
)"
PLUGIN_VERSION="$(
    node -e "const manifest = require(process.argv[1]); process.stdout.write(String(manifest.Version || '0.0.0'));" "${MANIFEST_PATH}"
)"
CODE_PATH="$(
    node -e "const manifest = require(process.argv[1]); process.stdout.write(String(manifest.CodePath || 'index.js'));" "${MANIFEST_PATH}"
)"

PACKAGED_PLUGIN_DIR_NAME="${PLUGIN_UUID}.sdPlugin"
OUTPUT_FILE_NAME="${PLUGIN_UUID}.streamDeckPlugin"
OUTPUT_FILE_PATH="${SCRIPT_DIR}/${OUTPUT_FILE_NAME}"
STAGING_ROOT="$(mktemp -d)"
STAGING_PLUGIN_DIR="${STAGING_ROOT}/${PACKAGED_PLUGIN_DIR_NAME}"

cleanup() {
    rm -rf "${STAGING_ROOT}"
}

trap cleanup EXIT

echo "Preparazione plugin Stream Deck..."
cp -a "${SOURCE_PLUGIN_DIR}" "${STAGING_PLUGIN_DIR}"

find "${STAGING_PLUGIN_DIR}" -name '.DS_Store' -delete
find "${STAGING_PLUGIN_DIR}" -name '.git' -type d -prune -exec rm -rf {} +
find "${STAGING_PLUGIN_DIR}" -name '.idea' -type d -prune -exec rm -rf {} +
find "${STAGING_PLUGIN_DIR}" -name '.gitignore' -delete

if [[ ! -f "${STAGING_PLUGIN_DIR}/${CODE_PATH}" ]]; then
    echo "CodePath non trovato nel plugin pacchettizzato: ${CODE_PATH}" >&2
    exit 1
fi

if [[ ! -d "${STAGING_PLUGIN_DIR}/node_modules" ]]; then
    if [[ "${SKIP_DEPENDENCY_INSTALL}" == "1" ]]; then
        echo "Dipendenze non installate: node_modules assente e SKIP_DEPENDENCY_INSTALL=1." >&2
        echo "Il pacchetto generato potrebbe non funzionare in Stream Deck." >&2
    else
        if ! command -v npm >/dev/null 2>&1; then
            echo "npm e' richiesto per installare le dipendenze del plugin." >&2
            exit 1
        fi

        echo "Installazione dipendenze di produzione nel pacchetto..."
        (
            cd "${STAGING_PLUGIN_DIR}"
            npm install --omit=dev
        )
    fi
fi

if [[ -f "${OUTPUT_FILE_PATH}" ]]; then
    rm -f "${OUTPUT_FILE_PATH}"
fi

echo "Creazione archivio finale..."
(
    cd "${STAGING_ROOT}"
    zip -qr "${OUTPUT_FILE_PATH}" "${PACKAGED_PLUGIN_DIR_NAME}"
)

echo "Plugin Stream Deck creato con successo: ${OUTPUT_FILE_PATH}"
