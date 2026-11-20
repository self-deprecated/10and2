#!/usr/bin/env bash
# Builds aac.wasm: the Fraunhofer FDK AAC encoder (2.0.3, unmodified, encoder only) and encoder.c, as a standalone
# WebAssembly module with no runtime: the cloud imports it as a module (Workers can't compile WebAssembly from bytes),
# Lattice compiles it from the file. The source and the compiler come from the repo's nixpkgs, so a rebuild makes the
# same file. Run from anywhere: brain/src/voice/aac/build.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
src=$(nix build --inputs-from "$root" nixpkgs#fdk_aac.src --no-link --print-out-paths 2>/dev/null)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -xzf "$src" -C "$work"
lib=$(echo "$work"/fdk-aac-*)
sources=()
for d in libAACenc libSBRenc libSACenc libMpegTPEnc libPCMutils libFDK libSYS; do
  while read -r f; do sources+=("$lib/$f"); done < <(grep -oE "^[[:space:]]*$d/src/[A-Za-z0-9_]+\.cpp" "$lib/Makefile.am" | tr -d ' \t')
done
includes=()
for d in "$lib"/lib*/include; do includes+=(-I "$d"); done
nix shell --inputs-from "$root" nixpkgs#emscripten -c emcc "${sources[@]}" "$here/encoder.c" "${includes[@]}" \
  -fno-exceptions -fno-rtti -Wno-everything -Oz -flto \
  -sSTANDALONE_WASM=1 --no-entry -sMALLOC=emmalloc -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=4MB -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS='["_aac_open","_aac_input","_aac_encode","_aac_output","_aac_taken","_aac_close"]' \
  -o "$here/aac.wasm"
cp "$lib/NOTICE" "$here/LICENSE.fdk-aac"
echo "built $here/aac.wasm ($(wc -c < "$here/aac.wasm") bytes) from $(basename "$src")"
