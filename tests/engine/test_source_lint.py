import re

from conftest import ENGINE

SRC = ENGINE.read_text(encoding="utf-8")

FORBIDDEN = [
    "eval(", "new Function", "<script", "import(", "<<", "data-testid", "data-slot",
    "document.body",
]


def test_engine_exists_and_small():
    assert ENGINE.exists()
    assert len(SRC.encode("utf-8")) < 60 * 1024


def test_no_forbidden_strings():
    bad = [s for s in FORBIDDEN if s in SRC]
    assert bad == []


def test_mutation_observer_only_on_document_element():
    assert "MutationObserver" in SRC
    for m in re.finditer(r"MutationObserver", SRC):
        window = SRC[m.start(): m.start() + 400]
        assert "document.body" not in window
    assert re.search(r"\.observe\(\s*document\.documentElement", SRC)


def test_no_dependencies_single_function():
    s = SRC.strip().rstrip(";")
    assert s.startswith("function pinpointEngine(")
    assert not re.search(r"^\s*(import|export)\s", SRC, re.M)
    assert "require(" not in SRC
