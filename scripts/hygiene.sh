#!/usr/bin/env bash
# Install-scanner hygiene (PLAN E5). Scans TRACKED files only.
# Exit 1 on any hit. Run from the repo root.
set -u
cd "$(git rev-parse --show-toplevel)"
fail=0
bad() { echo "HYGIENE FAIL: $*"; fail=1; }

# 1. compiled artifacts (catalog rule 17)
hits=$(git ls-files | grep -E '(^|/)__pycache__/|\.py[co]$')
[ -n "$hits" ] && bad "bytecode tracked:" && echo "$hits"

# 2. binary headers (MZ, ELF, Mach-O, wasm) in any tracked file
while IFS= read -r f; do
  [ -f "$f" ] || continue
  magic=$(head -c 4 "$f" | od -An -tx1 | tr -d ' \n')
  case "$magic" in
    4d5a*|7f454c46|cafebabe|feedface|feedfacf|cffaedfe|cefaedfe|0061736d)
      bad "binary header in $f ($magic)";;
  esac
done < <(git ls-files)

# 3. forbidden code patterns in shipped source (not tests, demo, tools, docs, this script)
shipped=$(git ls-files | grep -E '\.(js|mjs|py|html)$' | grep -Ev '^(tests|demo|tools|docs|scripts)/')
if [ -n "$shipped" ]; then
  # xargs avoids a huge command line; patterns per SPEC 4.1 / catalog rule 8
  echo "$shipped" | xargs grep -nE '<<[[:space:]]*[0-9]+|\beval[[:space:]]*\(|new[[:space:]]+Function|<script|\bimport[[:space:]]*\(|data-testid|data-slot|document\.body[^;]*observe|observe\([[:space:]]*document\.body' \
    && bad "forbidden pattern in shipped source (see lines above)"
fi

[ "$fail" = 0 ] && echo "hygiene ok" || exit 1
