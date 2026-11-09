"""Shared truth-table cases (tests/shared/delta_cases.json) through the Python store.

The same file is consumed by tests/build/delta-cases.test.mjs against desktop/src/bridge.js localDelta.
"""
import copy
import json
from pathlib import Path

import pytest

DATA = json.loads((Path(__file__).resolve().parents[1] / "shared" / "delta_cases.json").read_text(encoding="utf-8"))
URL = DATA["url"]


def _first(store, setup):
    res = {"url": URL, "score": setup["score"], "findings": copy.deepcopy(setup["findings"])}
    if setup.get("audit_options") is not None:
        res["audit_options"] = setup["audit_options"]
    out = store.record_audit(res)
    assert out["audit_id"] is not None
    if setup["dismissed"]:
        assert store.set_status(URL, setup["dismissed"], "dismissed", "intentional") == len(setup["dismissed"])


@pytest.mark.parametrize("case", DATA["cases"], ids=[c["name"] for c in DATA["cases"]])
def test_shared_delta_case(store, case):
    setup, result, expect = case["setup"], copy.deepcopy(case["result"]), case["expect"]
    if setup is not None:
        _first(store, setup)
    before = store.list_pins(URL)
    out = store.record_audit(result)
    if expect.get("rejected"):
        assert out["audit_id"] is None and out["delta"] is None
        assert store.list_pins(URL) == before          # no state mutation
        return
    if setup is None:
        assert out["delta"] is None
        return
    d = out["delta"]
    assert d is not None
    for k in ("fixed", "gone", "not_rechecked", "new"):
        assert d[k] == expect[k], k
    assert d["remaining"] == expect["remaining"]
    assert d["unresolved"] == d["not_rechecked"]
    assert {p["id"]: p["status"] for p in store.list_pins(URL)} == expect["statuses"]
    assert d["prev_score"] == setup["score"]
    assert isinstance(d["receipt"], str) and f"fixed" in d["receipt"]
    # fixed / gone / not_rechecked are disjoint
    assert len(set(d["fixed"]) | set(d["gone"]) | set(d["not_rechecked"])) == len(d["fixed"]) + len(d["gone"]) + len(d["not_rechecked"])


@pytest.mark.parametrize("r", DATA["receipts"], ids=[r["name"] for r in DATA["receipts"]])
def test_shared_receipt_text(store, r):
    assert store.format_receipt(r["prev_score"], r["score"], r["fixed"], r["gone"], r["remaining"], r["not_rechecked"]) == r["text"]


def test_options_signature_roundtrip(store):
    assert store.options_sig({"contrast": "AA", "tapAdvisory": 44}) == "AA|44"
    assert store.options_sig({"contrast": "AAA", "tapAdvisory": 0}) == "AAA|0"
    for bad in (None, {}, {"contrast": "AA"}, {"contrast": "X", "tapAdvisory": 44}, {"contrast": "AA", "tapAdvisory": True},
                {"contrast": "AA", "tapAdvisory": -1}, {"contrast": "AA", "tapAdvisory": "44"}, "AA|44"):
        assert store.options_sig(bad) is None
