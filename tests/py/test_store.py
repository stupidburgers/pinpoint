import json
from pathlib import Path

import pytest

CASES = json.loads((Path(__file__).resolve().parents[1] / "shared" / "url_key_cases.json").read_text("utf-8"))


def test_case_table_size():
    assert len(CASES) >= 12


@pytest.mark.parametrize("c", CASES, ids=[str(i) for i in range(len(CASES))])
def test_url_key(store, c):
    assert store.url_key(c["url"]) == c["key"]


def test_url_key_garbage(store):
    assert store.url_key(None) == ""
    assert store.url_key(42) == ""


URL = "http://localhost:5173/"


def F(n, sev="high", rule="a11y.contrast", label="btn"):
    return {"id": f"{rule}@{n:08x}", "rule": rule, "sev": sev, "selector": f"#e{n}", "label": label,
            "note": "n", "fix": "f", "measured": {"ratio": 1.9}, "rect": {"x": 0, "y": 0, "w": 1, "h": 1}}


def audit(ns, score=50, url=URL):
    fs = [F(n) for n in ns]
    return {"url": url, "score": score, "counts": {"high": len(fs), "medium": 0, "low": 0}, "findings": fs, "rules_covered": ["a11y.contrast"]}


@pytest.fixture
def clock(store, monkeypatch):
    t = {"v": 1000.0}
    monkeypatch.setattr(store, "_now", lambda: t["v"])

    def tick(d=1.0):
        t["v"] += d
        return t["v"]
    return tick


def test_schema_created(store, host):
    with store.connect() as c:
        tables = {r[0] for r in c.execute("select name from sqlite_master where type='table'")}
        assert {"audits", "pins"} <= tables
        cols = [r[1] for r in c.execute("pragma table_info(pins)")]
        assert cols == ["url_key", "id", "status", "finding", "first_seen", "last_seen", "reason"]
        cols = [r[1] for r in c.execute("pragma table_info(audits)")]
        assert cols == ["id", "url_key", "url", "t", "score", "counts", "source"]


def test_first_audit_has_no_delta(store, clock):
    r = store.record_audit(audit([1, 2]), "user")
    assert r["audit_id"] == 1 and r["delta"] is None and r["url_key"] == "http://localhost:5173"
    pins = store.list_pins(URL)
    assert sorted(p["status"] for p in pins) == ["open", "open"]


def test_delta_fixed_new_remaining(store, clock):
    store.record_audit(audit([1, 2, 3], 40), "user")
    clock()
    r = store.record_audit(audit([3, 4], 70), "auto")
    d = r["delta"]
    assert d["prev_score"] == 40
    assert sorted(d["fixed"]) == [F(1)["id"], F(2)["id"]]
    assert d["new"] == [F(4)["id"]]
    assert d["remaining"] == 1
    st = {p["id"]: p["status"] for p in store.list_pins(URL)}
    assert st[F(1)["id"]] == "fixed" and st[F(3)["id"]] == "open" and st[F(4)["id"]] == "new"


def test_new_becomes_open_next_audit(store, clock):
    store.record_audit(audit([1]), "user")
    store.record_audit(audit([1, 2]), "user")
    store.record_audit(audit([1, 2]), "user")
    st = {p["id"]: p["status"] for p in store.list_pins(URL)}
    assert st[F(2)["id"]] == "open"


def test_reappearing_fixed_pin_reopens(store, clock):
    store.record_audit(audit([1, 2]), "user")
    store.record_audit(audit([2]), "user")
    r = store.record_audit(audit([1, 2]), "user")
    assert r["delta"]["new"] == []  # id existed before
    assert {p["id"]: p["status"] for p in store.list_pins(URL)}[F(1)["id"]] == "open"


def test_first_seen_kept_last_seen_updated(store, clock):
    store.record_audit(audit([1]), "user")
    clock(10)
    store.record_audit(audit([1]), "user")
    p = store.list_pins(URL)[0]
    assert p["first_seen"] == 1000.0 and p["last_seen"] == 1010.0


def test_dismissed_suppressed(store, clock):
    store.record_audit(audit([1, 2], 50), "user")
    assert store.set_status(URL, [F(1)["id"]], "dismissed", "intentional") == 1
    r = store.record_audit(audit([1, 2], 55), "user")
    ids = [f["id"] for f in r["findings"]]
    assert ids == [F(2)["id"]]
    assert r["suppressed"] == 1
    assert r["delta"]["fixed"] == [] and r["delta"]["remaining"] == 1
    p = {p["id"]: p for p in store.list_pins(URL)}[F(1)["id"]]
    assert p["status"] == "dismissed" and p["reason"] == "intentional"
    assert store.dismissed_ids(URL) == [F(1)["id"]]


def test_reopen(store, clock):
    store.record_audit(audit([1]), "user")
    store.set_status(URL, [F(1)["id"]], "dismissed", "x")
    assert store.set_status(URL, [F(1)["id"]], "open") == 1
    r = store.record_audit(audit([1]), "user")
    assert len(r["findings"]) == 1


def test_set_status_unknown_ids_and_bad_status(store, clock):
    store.record_audit(audit([1]), "user")
    assert store.set_status(URL, ["nope"], "dismissed", "r") == 0
    with pytest.raises(ValueError):
        store.set_status(URL, [F(1)["id"]], "weird")


def test_clear(store, clock):
    store.record_audit(audit([1]), "user")
    assert store.clear(URL) >= 1
    assert store.list_pins(URL) == []
    assert store.get_store(URL)["last"] is None
    assert store.last_url_key() is None


def test_get_store_shape(store, clock):
    store.record_audit(audit([1], 61), "user")
    s = store.get_store(URL)
    assert s["last"]["score"] == 61 and s["last"]["audit_id"] == 1
    p = s["pins"][0]
    assert set(p) >= {"id", "status", "finding", "first_seen", "last_seen"}
    assert p["finding"]["selector"] == "#e1"


def test_last_url_key(store, clock):
    store.record_audit(audit([1], url="http://a.test/"), "user")
    clock()
    store.record_audit(audit([1], url="http://b.test/x"), "user")
    assert store.last_url_key() == "http://b.test/x"


def test_ingest_sanitises_strings(store, clock):
    f = F(1, label="bad\u202e\x00" + "L" * 100)
    f["selector"] = "div<script>"
    r = store.record_audit({"url": URL, "score": 1, "counts": {}, "findings": [f]}, "user")
    out = r["findings"][0]
    assert len(out["label"]) == 40 and "\u202e" not in out["label"]
    assert out["selector"] == ""


def test_prune_pins_per_key(store, clock):
    store.record_audit(audit(list(range(250)), 1), "user")
    assert len(store.list_pins(URL)) == 200


def test_prune_audits_per_key(store, clock):
    for i in range(55):
        clock()
        store.record_audit(audit([1], i), "user")
    with store.connect() as c:
        n = c.execute("select count(*) from audits").fetchone()[0]
        newest = c.execute("select max(score) from audits").fetchone()[0]
    assert n == 50 and newest == 54


def test_prune_url_keys_lru(store, clock):
    for i in range(23):
        clock()
        store.record_audit(audit([1], url=f"http://site{i}.test/"), "user")
    with store.connect() as c:
        keys = {r[0] for r in c.execute("select distinct url_key from audits")}
        pk = {r[0] for r in c.execute("select distinct url_key from pins")}
    assert len(keys) == 20 and pk == keys
    assert "http://site0.test" not in keys and "http://site22.test" in keys


def test_bad_inputs_do_not_raise(store, clock):
    for bad in (None, {}, {"url": ""}, {"url": URL, "findings": "x"}, {"url": URL, "findings": [None, 3, {}]}):
        r = store.record_audit(bad, "user")
        assert isinstance(r, dict)
