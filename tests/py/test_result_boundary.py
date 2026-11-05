"""Shared malformed-result contract at the persistent public store boundary."""
import json
from pathlib import Path

import pytest

CASES = json.loads((Path(__file__).resolve().parents[1] / "shared" / "audit_result_cases.json").read_text("utf-8"))
URL = "https://proof.invalid/"
F = {"id": "a11y.control-name@412214a1", "rule": "a11y.control-name", "sev": "high"}


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_raw_result_cannot_falsely_fix(store, case):
    base = {"url": URL, "score": 100, "findings": [], "rules_covered": [F["rule"]]}
    store.record_audit({**base, "findings": [F]})
    incoming = {**base, **case["patch"]}
    for field in case.get("omit", []):
        incoming.pop(field, None)
    result = store.record_audit(incoming)
    delta = result.get("delta")
    if case["fixed"]:
        assert delta["fixed"] == [F["id"]]
        assert store.list_pins(URL)[0]["status"] == "fixed"
    else:
        assert not delta or delta["fixed"] == []
        assert store.list_pins(URL)[0]["status"] == "open"
        if delta:
            assert delta["not_rechecked"] == [F["id"]]
    # Invalid input must not prevent a later genuine comparable repair.
    repaired = store.record_audit(base)
    assert store.list_pins(URL)[0]["status"] == "fixed"
    if not case["fixed"]:
        assert repaired["delta"]["fixed"] == [F["id"]]
