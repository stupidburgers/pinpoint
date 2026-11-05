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
                              "presentAnchors": ["div|#other|body"], "presentComplete": True})
    d = out["delta"]
    assert d["fixed"] == [] and d["gone"] == [F["id"]]
    assert "NOT proof of a fix" in d["receipt"]
    assert store.list_pins(URL)[0]["status"] == "gone"


def test_element_still_present_is_fixed(store):
    _first(store)
    out = store.record_audit({"url": URL, "score": 100, "findings": [], "rules_covered": [RULE],
                              "presentAnchors": [SIG], "presentComplete": True})
    d = out["delta"]
    assert d["fixed"] == [F["id"]] and d["gone"] == []
    assert "80 -> 100" in d["receipt"]
    assert store.list_pins(URL)[0]["status"] == "fixed"


def test_unknown_presence_keeps_legacy_behaviour(store):
    _first(store)
    out = store.record_audit({"url": URL, "score": 100, "findings": [], "rules_covered": [RULE]})
    assert out["delta"]["fixed"] == [F["id"]] and out["delta"]["gone"] == []


def test_incomplete_presence_is_unverified_not_fixed(store):
    _first(store)
    out = store.record_audit({"url": URL, "score": 100, "findings": [], "rules_covered": [RULE],
                              "presentAnchors": [f"x|{n}|y" for n in range(4000)], "presentComplete": False})
    d = out["delta"]
    assert d["fixed"] == [] and d["gone"] == [] and d["not_rechecked"] == [F["id"]]
    assert store.list_pins(URL)[0]["status"] == "open"


def test_missing_flag_counts_as_incomplete(store):
    _first(store)
    out = store.record_audit({"url": URL, "score": 100, "findings": [], "rules_covered": [RULE],
                              "presentAnchors": [SIG]})
    assert out["delta"]["fixed"] == [] and out["delta"]["not_rechecked"] == [F["id"]]


def test_ambiguous_signature_is_unverified(store):
    _first(store)
    out = store.record_audit({"url": URL, "score": 100, "findings": [], "rules_covered": [RULE],
                              "presentAnchors": [SIG, SIG], "presentComplete": True})
    assert out["delta"]["fixed"] == [] and out["delta"]["not_rechecked"] == [F["id"]]


def test_pin_without_signature_is_unverified_when_presence_is_known(store):
    legacy = {"id": RULE + "@bbbbbbbb", "rule": RULE, "sev": "high", "anchor": {"tag": "button"}}
    store.record_audit({"url": URL, "score": 80, "findings": [legacy], "rules_covered": [RULE]})
    out = store.record_audit({"url": URL, "score": 100, "findings": [], "rules_covered": [RULE],
                              "presentAnchors": [SIG], "presentComplete": True})
    assert out["delta"]["fixed"] == [] and out["delta"]["not_rechecked"] == [legacy["id"]]
