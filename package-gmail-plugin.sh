#!/bin/bash

# Nome del plugin
PLUGIN_NAME="com.delda.gmail.sdPlugin"
OUTPUT_NAME="com.delda.gmail.streamDeckPlugin"

echo "Packaging plugin..."

# Rimuovi eventuali file vecchi
rm -f "$OUTPUT_NAME"

# Crea il file zip rinominato in .streamDeckPlugin
# Includiamo la cartella principale del plugin, escludendo file sensibili e temporanei
zip -r "$OUTPUT_NAME" "$PLUGIN_NAME" -x "$PLUGIN_NAME/token.json" "$PLUGIN_NAME/credentials.json" "$PLUGIN_NAME/.git*" "com.delda.gmail.sdPlugin.zip"

echo "Plugin pacchettizzato con successo: $OUTPUT_NAME"
