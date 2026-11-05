#!/usr/bin/env bash
# Freeze for submission: verify, then pin plugin-catalog/pinpoint.yaml to HEAD.
# Usage: bash scripts/freeze.sh            (from anywhere)
# Needs: git, python (3.11+, with pytest/playwright/fastapi/httpx/pyyaml), node, hermes CLI.
# The pinned SHA is the commit BEFORE the yaml rewrite; the yaml edit is committed
# afterwards (a commit cannot contain its own hash).
set -euo pipefail
export PATH="/c/Program Files/Git/cmd:$PATH"
cd "$(git rev-parse --show-toplevel)"
PY="env -u PYTHONPATH python"
step() { printf '\n== %s\n' "$*"; }
die()  { echo "FREEZE ABORTED: $*" >&2; exit 1; }

step "1. clean tree, in sync with origin"
[ -z "$(git status --porcelain)" ] || { git status --short; die "working tree not clean"; }
git fetch origin main -q
SHA=$(git rev-parse HEAD)
[ "$SHA" = "$(git rev-parse origin/main)" ] || die "HEAD $SHA != origin/main $(git rev-parse origin/main) (push or pull first)"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "not a 40-hex sha: $SHA"

step "2. placeholders gone"
if grep -n '<!-- FILL:' README.md; then die "FILL markers remain (docs/fill-images.md)"; fi
for f in docs/banner.png docs/screenshots/01-pins.png docs/screenshots/02-pin-card.png docs/screenshots/03-after-fix.png docs/metrics.md; do
  git cat-file -e "$SHA:$f" 2>/dev/null || die "missing at $SHA: $f"
done

step "3. hygiene scan"
bash scripts/hygiene.sh

step "4. pytest"
$PY -m pytest tests/py tests/engine -q

step "5. desktop build check"
node scripts/build-desktop.mjs --check

step "6. hermes plugins validate"
VH=$(mktemp -d)
HERMES_HOME="$VH" hermes plugins validate . | tee "$VH/validate.txt"
grep -q 'Validation passed\.' "$VH/validate.txt" || die "validate did not print 'Validation passed.'"
! grep -q '✗' "$VH/validate.txt" || die "validate output has a failed check"

step "7. rewrite plugin-catalog/pinpoint.yaml"
SHA="$SHA" $PY - <<'PYEOF'
import os, re, sys
sha = os.environ["SHA"]
cat = open("plugin-catalog/pinpoint.yaml", encoding="utf-8").read()
plug = open("plugin.yaml", encoding="utf-8").read()
ver = re.search(r'^version:\s*"?([^"\s#]+)', plug, re.M).group(1)
cat = re.sub(r'^sha:\s*"[0-9a-f]{40}"', f'sha: "{sha}"', cat, flags=re.M)
cat = re.sub(r'^(version:\s*)"[^"]*"', rf'\1"{ver}"', cat, flags=re.M)
cat = re.sub(r'(raw\.githubusercontent\.com/stupidburgers/pinpoint/)[0-9a-f]{40}/', rf'\g<1>{sha}/', cat)
cat = re.sub(r'\s+# PLACEHOLDER[^\n]*', '', cat)
open("plugin-catalog/pinpoint.yaml", "w", encoding="utf-8", newline="\n").write(cat)
import yaml
d = yaml.safe_load(cat)
assert d["sha"] == sha and re.fullmatch(r"[0-9a-f]{40}", d["sha"])
for u in [d["image"], *d["screenshots"]]:
    assert sha in u, u
assert d["version"] == ver
assert d["capabilities"]["provides_tools"] == ["pinpoint_audit", "pinpoint_pins"]
print("yaml ok, version", ver)
PYEOF
git diff --stat plugin-catalog/pinpoint.yaml

echo
echo "PINNED SHA: $SHA"
echo "Next: git add plugin-catalog/pinpoint.yaml && git commit -m 'chore: pin catalog entry to ${SHA:0:8}' && git push"
echo "Then copy plugin-catalog/pinpoint.yaml into a NousResearch/hermes-agent PR (docs/SUBMISSION.md)."
