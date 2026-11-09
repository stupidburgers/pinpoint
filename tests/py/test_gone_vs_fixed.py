"""A pin whose element vanished is 'gone', not 'fixed'; 'fixed' needs coverage + options + one present signature."""
URL = "https://gone.invalid/"
RULE = "a11y.control-name"
SIG = "button|#buy|body"
AO = {"contrast": "AA", "tapAdvisory": 44}
F = {"id": RULE + "@aaaaaaaa", "rule": RULE, "sev": "high", "anchor": {"tag": "button", "sig": SIG}}


def _first(store):
    store.record_audit({"url": URL, "score": 80, "findings": [F], "rules_covered": [RULE], "audit_options": AO})


def _second(store, **extra):
    res = {"url": URL, "score": 100, "findings": [], "rules_covered": [RULE], "audit_options": AO,
           "stats": {"checked": {RULE: 1}, "skipped": {}}}
    res.update(extra)
    return store.record_audit(res)["delta"]


def test_element_removed_is_gone_not_fixed(store):
    _first(store)
    d = _second(store, presentAnchors=["div|#other|body"], presentComplete=True)
    assert d["fixed"] == [] and d["gone"] == [F["id"]]
    assert "NOT proof of a fix" in d["receipt"]
    assert store.list_pins(URL)[0]["status"] == "gone"


def test_element_still_present_is_fixed_but_not_remeasured(store):
    _first(store)
    d = _second(store, presentAnchors=[SIG], presentComplete=True)
    assert d["fixed"] == [F["id"]] and d["gone"] == []
    assert "80 -> 100" in d["receipt"] and "NOT re-measured" in d["receipt"]
    assert store.list_pins(URL)[0]["status"] == "fixed"


def test_unknown_presence_is_not_rechecked_no_legacy_exception(store):
    _first(store)
    d = _second(store)
    assert d["fixed"] == [] and d["gone"] == [] and d["not_rechecked"] == [F["id"]]
    assert store.list_pins(URL)[0]["status"] == "open"


def test_incomplete_presence_is_unverified_not_fixed(store):
    _first(store)
    d = _second(store, presentAnchors=[f"x|{n}|y" for n in range(4000)], presentComplete=False)
    assert d["fixed"] == [] and d["gone"] == [] and d["not_rechecked"] == [F["id"]]
    assert store.list_pins(URL)[0]["status"] == "open"


def test_missing_flag_counts_as_incomplete(store):
    _first(store)
    d = _second(store, presentAnchors=[SIG])
    assert d["fixed"] == [] and d["not_rechecked"] == [F["id"]]


def test_ambiguous_signature_is_unverified(store):
    _first(store)
    d = _second(store, presentAnchors=[SIG, SIG], presentComplete=True)
    assert d["fixed"] == [] and d["not_rechecked"] == [F["id"]]


def test_pin_without_signature_is_unverified_when_presence_is_known(store):
    legacy = {"id": RULE + "@bbbbbbbb", "rule": RULE, "sev": "high", "anchor": {"tag": "button"}}
    store.record_audit({"url": URL, "score": 80, "findings": [legacy], "rules_covered": [RULE], "audit_options": AO})
    d = _second(store, presentAnchors=[SIG], presentComplete=True)
    assert d["fixed"] == [] and d["not_rechecked"] == [legacy["id"]]


def test_page_cannot_forge_the_options_stamp(store):
    """A finding carrying audit_sig from the page is overwritten by the host-supplied audit_options."""
    forged = {**F, "audit_sig": "AAA|0"}
    store.record_audit({"url": URL, "score": 80, "findings": [forged], "audit_options": AO})
    assert store.list_pins(URL)[0]["finding"]["audit_sig"] == "AA|44"
    store.record_audit({"url": URL, "score": 80, "findings": [forged]})
    assert "audit_sig" not in store.list_pins(URL)[0]["finding"]
