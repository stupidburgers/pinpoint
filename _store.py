"""SQLite store for audits and pins (SPEC 4.3). Opens a short-lived connection per call."""
import contextlib
import json
import time
from urllib.parse import urlsplit

from ._sanitize import clean_selector, clean_text

MAX_KEYS = 20
MAX_PINS = 200
MAX_AUDITS = 50
STATUSES = ("open", "fixed", "dismissed", "new")
_DEFAULT_PORT = {"http": 80, "https": 443}
_DROP_PARAMS = ("fbclid", "gclid")

_SCHEMA = """
create table if not exists audits(
  id integer primary key, url_key text, url text, t real, score int, counts text, source text);
create table if not exists pins(
  url_key text, id text, status text, finding text, first_seen real, last_seen real, reason text,
  primary key(url_key, id));
create index if not exists audits_key on audits(url_key, id);
"""


def _now():
    return time.time()


def url_key(url):
    """origin + pathname (+ ?sorted query minus utm_*/fbclid/gclid) (+ #/route). '' if not a URL."""
    if not isinstance(url, str):
        return ""
    try:
        u = urlsplit(url.strip())
        scheme = u.scheme.lower()
        host = (u.hostname or "").lower()
        port = u.port
    except ValueError:
        return ""
    if not scheme or (not host and scheme != "file"):
        return ""
    if ":" in host:
        host = f"[{host}]"
    origin = f"{scheme}://{host}"
    if port and port != _DEFAULT_PORT.get(scheme):
        origin += f":{port}"
    key = origin + u.path.rstrip("/")
    pairs = []
    for part in u.query.split("&") if u.query else []:
        name, _, val = part.partition("=")
        low = name.lower()
        if not name or low.startswith("utm_") or low in _DROP_PARAMS:
            continue
        pairs.append((name, val))
    if pairs:
        key += "?" + "&".join(f"{n}={v}" for n, v in sorted(pairs))
    if u.fragment.startswith("/"):
        key += "#" + u.fragment.rstrip("/")
    return key


@contextlib.contextmanager
def connect():
    from plugins.plugin_storage import plugin_db
    conn = plugin_db("pinpoint")
    try:
        conn.executescript(_SCHEMA)
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()


def clean_finding(f):
    """Sanitise page-originated strings of one finding (copy)."""
    out = dict(f)
    out["id"] = clean_text(f.get("id"), 80)
    out["rule"] = clean_text(f.get("rule"), 40)
    out["sev"] = f.get("sev") if f.get("sev") in ("high", "medium", "low") else "low"
    out["selector"] = clean_selector(f.get("selector"))
    out["label"] = clean_text(f.get("label"), 40)
    out["note"] = clean_text(f.get("note"), 200)
    out["fix"] = clean_text(f.get("fix"), 200)
    m = f.get("measured")
    if isinstance(m, dict):
        out["measured"] = {clean_text(k, 24): (v if isinstance(v, (int, float, bool)) else clean_text(v, 24))
                           for k, v in list(m.items())[:12]}
    else:
        out["measured"] = {}
    return out


def _extract_coverage(result):
    if not isinstance(result, dict):
        return set()
    covered = None
    rc = result.get("rules_covered")
    if isinstance(rc, list) and all(isinstance(x, str) for x in rc):
        covered = set(rc)
    else:
        stats = result.get("stats") if isinstance(result.get("stats"), dict) else None
        checked = stats.get("checked") if isinstance(stats, dict) else None
        if isinstance(checked, dict) and all(isinstance(k, str) for k in checked):
            covered = set(checked.keys())
        else:
            rules = result.get("rules")
            if isinstance(rules, list) and all(isinstance(x, str) for x in rules):
                covered = set(rules)
    if covered is None:
        return set()
    errors = result.get("errors")
    if isinstance(errors, list):
        for e in errors:
            if isinstance(e, dict) and isinstance(e.get("rule"), str):
                covered.discard(e["rule"])
    limits = result.get("limits")
    if (isinstance(limits, list) and limits) or (isinstance(limits, str) and limits.strip()):
        covered = set()
    return covered


def _rule_of_pin(pid):
    return str(pid).split("@", 1)[0]


def _empty_delta_result(url, key):
    return {"audit_id": None, "delta": None, "url_key": key, "findings": [], "suppressed": 0}


def record_audit(result, source="user"):
    """Store one AuditResult; returns {audit_id, delta, url_key, findings(visible), suppressed, score, counts}."""
    try:
        if not isinstance(result, dict):
            return _empty_delta_result("", "")
        url = clean_text(result.get("url"), 500)
        key = url_key(url)
        raw = result.get("findings")
        findings = [clean_finding(f) for f in raw if isinstance(f, dict) and f.get("id")] if isinstance(raw, list) else []
        if not key:
            return {**_empty_delta_result(url, key), "findings": findings}
        score = result.get("score")
        score = int(score) if isinstance(score, (int, float)) and not isinstance(score, bool) else None
        counts = result.get("counts") if isinstance(result.get("counts"), dict) else {}
        now = _now()
        with connect() as c:
            prev_audit = c.execute("select score from audits where url_key=? order by id desc limit 1", (key,)).fetchone()
            pins = {r[0]: (r[1], r[2], r[3]) for r in c.execute(
                "select id,status,first_seen,reason from pins where url_key=?", (key,))}
            dismissed = {i for i, p in pins.items() if p[0] == "dismissed"}
            visible = [f for f in findings if f["id"] not in dismissed]
            suppressed = len(findings) - len(visible)
            cur = {f["id"] for f in visible}
            prev_open = {i for i, p in pins.items() if p[0] in ("open", "new")}
            covered = _extract_coverage(result)
            if covered is None:
                covered = set()
            fixed = [i for i in pins if i in prev_open and i not in cur]
            fixed = [i for i in fixed if _rule_of_pin(i) in covered]
            new = [f["id"] for f in visible if f["id"] not in pins]
            remaining = len(cur & prev_open)
            cid = c.execute("insert into audits(url_key,url,t,score,counts,source) values(?,?,?,?,?,?)",
                            (key, url, now, score, json.dumps(counts), clean_text(source, 8))).lastrowid
            for i in fixed:
                c.execute("update pins set status='fixed' where url_key=? and id=?", (key, i))
            seen = set()
            for f in visible:
                if f["id"] in seen:
                    continue
                seen.add(f["id"])
                if f["id"] in pins:
                    c.execute("update pins set status='open', finding=?, last_seen=? where url_key=? and id=?",
                              (json.dumps(f), now, key, f["id"]))
                else:
                    status = "new" if prev_audit else "open"
                    c.execute("insert into pins values(?,?,?,?,?,?,NULL)",
                              (key, f["id"], status, json.dumps(f), now, now))
            for i in dismissed & {f["id"] for f in findings}:
                c.execute("update pins set last_seen=? where url_key=? and id=?", (now, key, i))
            delta = None
            if prev_audit:
                delta = {"prev_score": prev_audit[0], "fixed": fixed, "new": new, "remaining": remaining}
            _prune(c, key)
        return {"audit_id": cid, "delta": delta, "url_key": key, "findings": visible,
                "suppressed": suppressed, "score": score, "counts": counts}
    except Exception:
        return _empty_delta_result("", "")


def _prune(c, key):
    c.execute("delete from pins where url_key=? and id not in "
              "(select id from pins where url_key=? order by last_seen desc, first_seen desc, id limit ?)",
              (key, key, MAX_PINS))
    c.execute("delete from audits where url_key=? and id not in "
              "(select id from audits where url_key=? order by id desc limit ?)", (key, key, MAX_AUDITS))
    keys = [r[0] for r in c.execute("select url_key from audits group by url_key order by max(id) desc")]
    for k in keys[MAX_KEYS:]:
        c.execute("delete from audits where url_key=?", (k,))
        c.execute("delete from pins where url_key=?", (k,))
    live = set(keys[:MAX_KEYS])
    for (k,) in c.execute("select distinct url_key from pins").fetchall():
        if k not in live:
            c.execute("delete from pins where url_key=?", (k,))


def _pin_row(r):
    try:
        finding = json.loads(r[2])
    except (TypeError, ValueError):
        finding = {}
    d = {"id": r[0], "status": r[1], "finding": finding, "first_seen": r[3], "last_seen": r[4]}
    if r[5]:
        d["reason"] = r[5]
    return d


def list_pins(url, status=None):
    key = url_key(url) or (url if isinstance(url, str) else "")
    with connect() as c:
        rows = c.execute("select id,status,finding,first_seen,last_seen,reason from pins where url_key=? "
                         "order by first_seen, rowid", (key,)).fetchall()
    pins = [_pin_row(r) for r in rows]
    return [p for p in pins if status is None or p["status"] == status]


def dismissed_ids(url):
    return [p["id"] for p in list_pins(url, "dismissed")]


def get_store(url_or_key):
    key = url_key(url_or_key) or (url_or_key if isinstance(url_or_key, str) else "")
    pins = list_pins(key)
    with connect() as c:
        r = c.execute("select id,score,t from audits where url_key=? order by id desc limit 1", (key,)).fetchone()
    return {"pins": pins, "last": {"audit_id": r[0], "score": r[1], "t": r[2]} if r else None}


def last_url_key():
    with connect() as c:
        r = c.execute("select url_key from audits order by id desc limit 1").fetchone()
    return r[0] if r else None


def set_status(url, ids, status, reason=None):
    """Set status on existing pins; returns rows changed. Raises ValueError on a bad status."""
    if status not in STATUSES:
        raise ValueError(f"bad status {status!r}")
    key = url_key(url) or (url if isinstance(url, str) else "")
    reason = clean_text(reason, 200) or None if status == "dismissed" else None
    n = 0
    with connect() as c:
        for i in ids or []:
            n += c.execute("update pins set status=?, reason=? where url_key=? and id=?",
                           (status, reason, key, str(i))).rowcount
    return n


def clear(url):
    key = url_key(url) or (url if isinstance(url, str) else "")
    with connect() as c:
        n = c.execute("delete from pins where url_key=?", (key,)).rowcount
        n += c.execute("delete from audits where url_key=?", (key,)).rowcount
    return n
