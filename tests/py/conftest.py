"""Fixtures: load the plugin dir as a package and fake the Hermes host modules."""
import importlib.util
import sqlite3
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PKG = "pinpoint_pkg"


def _load_pkg():
    if PKG in sys.modules:
        return sys.modules[PKG]
    spec = importlib.util.spec_from_file_location(
        PKG, ROOT / "__init__.py", submodule_search_locations=[str(ROOT)])
    mod = importlib.util.module_from_spec(spec)
    sys.modules[PKG] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(autouse=True)
def host(tmp_path, monkeypatch):
    """Fake `plugins.plugin_storage` + `hermes_cli.plugin_events`; returns a recorder."""
    data_root = tmp_path / "plugin-data"
    events = []
    state = {"broadcast_raises": None}

    storage = types.ModuleType("plugins.plugin_storage")

    def plugin_data_dir(name):
        d = data_root / name
        d.mkdir(parents=True, exist_ok=True)
        return d

    def plugin_db(name, filename="data.db"):
        return sqlite3.connect(str(plugin_data_dir(name) / filename), check_same_thread=False)

    storage.plugin_data_dir = plugin_data_dir
    storage.plugin_db = plugin_db
    plugins_pkg = types.ModuleType("plugins")
    plugins_pkg.__path__ = []
    plugins_pkg.plugin_storage = storage

    pe = types.ModuleType("hermes_cli.plugin_events")

    def broadcast_plugin_event(plugin_id, event, payload=None):
        if state["broadcast_raises"]:
            raise state["broadcast_raises"]
        events.append((plugin_id, event, payload))

    pe.broadcast_plugin_event = broadcast_plugin_event
    hc = types.ModuleType("hermes_cli")
    hc.__path__ = []
    hc.plugin_events = pe

    monkeypatch.setitem(sys.modules, "plugins", plugins_pkg)
    monkeypatch.setitem(sys.modules, "plugins.plugin_storage", storage)
    monkeypatch.setitem(sys.modules, "hermes_cli", hc)
    monkeypatch.setitem(sys.modules, "hermes_cli.plugin_events", pe)

    class Host:
        pass

    h = Host()
    h.events = events
    h.state = state
    h.data_root = data_root
    h.rv = data_root / "pinpoint" / "rv"
    return h


@pytest.fixture
def pkg():
    return _load_pkg()


@pytest.fixture
def sanitize(pkg):
    return sys.modules[PKG + "._sanitize"] if PKG + "._sanitize" in sys.modules else __import__(PKG + "._sanitize", fromlist=["x"])


@pytest.fixture
def store(pkg):
    return __import__(PKG + "._store", fromlist=["x"])


@pytest.fixture
def core(pkg):
    return __import__(PKG + "._core", fromlist=["x"])


@pytest.fixture
def tools(pkg):
    return __import__(PKG + "._tools", fromlist=["x"])
