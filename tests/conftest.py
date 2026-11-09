"""Shared pytest guard: let `pytest tests/...` run from ANY checkout directory name."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _skip_root_package_import():
    """Make `pytest tests/py` work from ANY checkout directory name.

    The plugin root has an `__init__.py` full of relative imports, so pytest treats the root
    directory as a `Package` and, on first test setup, imports `<root>/__init__.py` by itself. When
    the checkout directory is not a valid Python identifier (e.g. `pp-r3`, `pinpoint-release`)
    pytest cannot derive a package name and imports it as a top-level `__init__`, which dies with
    "attempted relative import with no known parent package". The fixtures below already load the
    plugin as the proper package `PKG`, so skip pytest's own import of the root `__init__.py` only.
    """
    from _pytest import python as _py
    pkg_cls = getattr(_py, "Package", None)
    orig = getattr(pkg_cls, "setup", None)
    if orig is None or getattr(orig, "_pinpoint_patched", False):
        return

    def setup(self):
        try:
            if Path(str(self.path)).resolve() == ROOT:
                return
        except OSError:
            pass
        return orig(self)

    setup._pinpoint_patched = True
    pkg_cls.setup = setup


_skip_root_package_import()
