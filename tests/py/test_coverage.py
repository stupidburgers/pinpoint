"""Unknown or incomplete incoming scans cannot close persisted open pins."""
import pytest

URL = "https://coverage.invalid/"
RULE = "a11y.control-name"
F = {"id": RULE + "@412214a1", "rule": RULE, "sev": "high"}

@pytest.mark.parametrize("metadata", [
    {}, {"rules_covered": "broken"}, {"rules_covered": [None]},
    {"stats": {"checked": {}}}, {"stats": {"checked": {RULE: "bad"}}},
    {"rules": [RULE]}, {"rules_covered": []},
    {"rules_covered": [RULE], "errors": [{"rule": RULE, "message": "failed"}]},
    {"rules_covered": [RULE], "errors": [{"rule": "engine", "message": "failed"}]},
    {"rules_covered": [RULE], "truncated": True},
    {"rules_covered": [RULE], "limits": ["findings truncated: showing 200 of 201"]},
])
def test_unverified_absence_keeps_pin_open(store, metadata):
    # Legacy stored finding remains readable even without old audit coverage.
    store.record_audit({"url": URL, "score": 92, "findings": [F]})
    out = store.record_audit({"url": URL, "score": 100, "findings": [], **metadata})
    assert out["delta"]["fixed"] == []
    assert out["delta"]["not_rechecked"] == [F["id"]]
    assert store.list_pins(URL)[0]["status"] == "open"

def test_truncated_batch_retains_old_unmeasured_pin_at_storage_cap(store):
    store.record_audit({"url": URL, "findings": [F]})
    findings = [{**F, "id": RULE + f"@{n:08x}"} for n in range(200)]
    out = store.record_audit({"url": URL, "findings": findings, "rules_covered": [RULE],
                              "limits": ["findings truncated: showing 200 of 201"]})
    assert out["delta"]["fixed"] == []
    assert F["id"] in out["delta"]["not_rechecked"]
    assert {p["id"]: p["status"] for p in store.list_pins(URL)}.get(F["id"]) == "open"


@pytest.mark.parametrize("metadata", [
    {"rules_covered": [RULE]}, {"stats": {"checked": {RULE: 0}}},
    {"rules_covered": [RULE], "stats": {"checked": {RULE: 3}, "skipped": {}}, "presentAnchors": ["x|y|z"], "presentComplete": True},
])
def test_legacy_pin_without_options_or_signature_is_never_closed(store, metadata):
    """Coverage alone (the old 'presence exception') no longer turns absence into fixed or gone."""
    store.record_audit({"url": URL, "findings": [F]})
    out = store.record_audit({"url": URL, "findings": [], **metadata})
    assert out["delta"]["fixed"] == [] and out["delta"]["gone"] == []
    assert out["delta"]["not_rechecked"] == [F["id"]]
    assert store.list_pins(URL)[0]["status"] == "open"
