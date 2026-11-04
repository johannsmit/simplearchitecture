#!/bin/sh
# Checks that an app folder holds only what runs: no source maps, type declarations, TypeScript
# source, tests, docs, .env files, .git or model data; and that it holds the licence terms (LICENSE
# and the third-party notices). Used by the image build on the assembled app and by CI on the built
# image's /app. POSIX sh and awk, so it runs on macOS, on Linux and in the Alpine build stage alike.
#
#   deploy/check-image-files.sh <folder>          every file, link and folder under <folder>
#   deploy/check-image-files.sh --list <file|->   a list of paths relative to the app folder,
#                                                 one per line (folders may end in /)
#
# Inside node_modules (third-party packages) only the first group of rules applies: their
# READMEs and licence files stay, as their licences ask.
# Exits 1 and names each offending path (never its content) when anything is found.
set -eu

usage() {
  echo "Usage: $0 <folder> | --list <file|->" >&2
  exit 2
}

[ $# -ge 1 ] || usage
if [ "$1" = "--list" ]; then
  [ $# -eq 2 ] || usage
  if [ "$2" = "-" ]; then list=$(cat); else list=$(cat -- "$2"); fi
else
  [ $# -eq 1 ] && [ -d "$1" ] || usage
  dir=${1%/}
  list=$(cd -- "$dir" && find . -mindepth 1 \( -type f -o -type l -o -type d \) | sed 's#^\./##')
fi

printf '%s\n' "$list" | awk '
  function flag(path, reason) {
    found += 1
    if (found <= 50) printf "  %s  (%s)\n", path, reason
  }
  {
    path = $0
    sub(/^\.\//, "", path); sub(/^\/+/, "", path); sub(/\/+$/, "", path)
    if (path == "" || path == ".") next
    checked += 1
    if (path == "LICENSE") has_licence = 1
    if (path == "frontend/dist/third-party-licenses.txt") has_notices = 1
    n = split(path, part, "/")
    base = part[n]
    third_party = 0
    for (i = 1; i < n; i++) if (part[i] == "node_modules") third_party = 1
    if (base == "node_modules") third_party = 1

    # Everywhere, third-party packages included.
    if (base ~ /\.map$/) { flag(path, "source map"); next }
    if (base ~ /\.d\.[mc]?ts$/) { flag(path, "type declaration"); next }
    if (base ~ /^\.env/) { flag(path, "environment file"); next }
    if (base ~ /\.tsbuildinfo$/) { flag(path, "build cache"); next }
    if (base == "graph-export.json") { flag(path, "model data"); next }
    git = 0
    for (i = 1; i <= n; i++) if (part[i] == ".git") git = 1
    if (git) { flag(path, "git"); next }
    if (third_party) next

    # The app'"'"'s own files.
    if (base ~ /\.(ts|tsx|mts|cts)$/) { flag(path, "TypeScript source"); next }
    if (base ~ /\.(test|spec)\.[^.]+$/) { flag(path, "test"); next }
    if (base ~ /\.(md|markdown)$/) { flag(path, "document"); next }
    if (base ~ /\.(xml|archimate|log)$/) { flag(path, "model export or log"); next }
    if (base == ".DS_Store" || base == ".gitignore" || base == ".dockerignore") {
      flag(path, "local file"); next
    }
    for (i = 1; i <= n; i++) {
      p = part[i]
      if (p == "src" || p == "test" || p == "tests" || p == "__tests__" || p == "coverage") {
        flag(path, "source or tests"); next
      }
      if (p == "docs") { flag(path, "docs"); next }
      if (p == "data" || p == "test-files") { flag(path, "model data"); next }
      if (p == "samples") { flag(path, "sample model"); next }
    }
  }
  END {
    if (found > 50) printf "  ... and %d more\n", found - 50
    if (checked > 0 && !has_licence) { print "  LICENSE  (required, missing)"; missing += 1 }
    if (checked > 0 && !has_notices) {
      print "  frontend/dist/third-party-licenses.txt  (required, missing)"
      missing += 1
    }
    if (missing > 0) {
      printf "Image contents check failed: %d required files are missing.\n", missing
      exit 1
    }
    if (found > 0) {
      printf "Image contents check failed: %d of %d paths must not be in the image.\n", found, checked
      exit 1
    }
    if (checked == 0) { print "Image contents check failed: no files to check."; exit 1 }
    printf "Image contents check passed: %d paths, none of them source, maps, tests, docs, secrets or data; the licence terms are there.\n", checked
  }
'
