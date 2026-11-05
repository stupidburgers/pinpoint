"""A pin whose element vanished is 'gone', not 'fixed'; only a re-measured element counts as fixed."""
URL = "https://gone.invalid/"
RULE = "a11y.control-name"
SIG = "button|#buy|body"
F = {"id": RULE + "@aaaaaaaa", "rule": RULE, "sev": "high", "anchor": {"tag": "button", "sig": SIG}}


def _first(store):
    store.record_audit({"url": URL, "score": 80, "findings": [F], "rules_covered": [RULE]})


def test_element_removed_is_gone_not_fixed(store):
    _first(store)
    out = store.record_audit({"url": URL, "score": 100, "findings": [], "rules_covered": [RULE],
                              "presentAnchors": ["div|#other|body"]})
    d = out["delta"]
    assert d["fixed"] == [] and d["gone"] == [F["id"]]
    assert "NOT proof of a fix" in d["receipt"]
    assert store.list_pins(URL)[0]["status"] == "gone"


def test_element_still_present_is_fixed(store):
    _first(store)
    out = store.record_audit({"url": URL, "score": 100, "findings": [], "rules_covered": [RULE],
                              "presentAnchors": [SIG]})
    d = out["delta"]
    assert d["fixed"] == [F["id"]] and d["gone"] == []
    assert "80 -> 100" in d["receipt"]
    assert store.list_pins(URL)[0]["status"] == "fixed"


def test_unknown_presence_keeps_legacy_behaviour(store):
    _first(store)
    out = store.record_audit({"url": URL, "score": 100, "findings": [], "rules_covered": [RULE]})
    assert out["delta"]["fixed"] == [F["id"]] and out["delta"]["gone"] == []


def test_truncated_presence_list_is_not_trusted(store):
    _first(store)
    out = store.record_audit({"url": URL, "score": 100, "findings": [], "rules_covered": [RULE],
                              "presentAnchors": [f"x|{n}|y" for n in range(2000)]})
    assert out["delta"]["gone"] == []
