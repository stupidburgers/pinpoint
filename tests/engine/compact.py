# Regenerate engine/pinpoint-engine.js from the readable full source.
# Usage:  env -u PYTHONPATH python tests/engine/compact.py
import pathlib, shutil, subprocess, sys

HERE = pathlib.Path(__file__).parent
SRC = HERE / "pinpoint-engine.full.js"
OUT = HERE.parent.parent / "engine" / "pinpoint-engine.js"


def compact():
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        sys.exit("npx not found; cannot run terser")
    # -c false -m false keeps names; --keep_fnames keeps the function name needed by the desktop build
    cmd = [npx, "--yes", "terser@5", str(SRC), "-c", "pure_funcs=[]", "-m", "reserved=['window','document']",
           "--keep_fnames", "-o", str(OUT)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if r.returncode:
        sys.exit(f"terser failed: {r.stderr[-500:]}")
    print(f"{OUT.stat().st_size} bytes")


if __name__ == "__main__":
    compact()
