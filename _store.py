"""SQLite store for audits and pins (SPEC 4.3). Opens a short-lived connection per call."""
import contextlib
import json
import time
from urllib.parse import urlsplit

from ._sanitize import clean_selector, clean_text

MAX_KEYS = 20
MAX_PINS = 200
MAX_AUDITS = 50
MAX_AGE_SECONDS = 7 * 86400  # 7-day retention limit
STATUSES = ("open", "fixed", "gone", "dismissed", "new")
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


def _empty_delta_result(url, key):
    return {"audit_id": None, "delta": None, "url_key": key, "findings": [], "suppressed": 0}


def options_sig(opts):
    """'AA|44' for a valid audit_options dict (contrast level + tap advisory), else None. Mirrors bridge.js optionsSig."""
    if not isinstance(opts, dict):
        return None
    c, t = opts.get("contrast"), opts.get("tapAdvisory")
    if c not in ("AA", "AAA") or isinstance(t, bool) or not isinstance(t, (int, float)) or t < 0 or t != t:
        return None
    return f"{c}|{int(t) if float(t).is_integer() else t}"


def _extract_coverage(result):
    """Rules whose absence of findings may count: only the engine's actual `rules_covered`.

    Requested rules, returned findings and the legacy `stats.checked` map (incremented before an element is
    skipped) are not execution evidence. Any engine error, truncation, non-empty limit or malformed
    errors/limits metadata empties the set. Mirrors bridge.js auditCoverage.
    """
    errors = result.get("errors", [])
    limits = result.get("limits", [])
    if not isinstance(errors, list) or not isinstance(limits, list):
        return set()
    if any(not isinstance(e, dict) or not isinstance(e.get("rule"), str)
           or not e["rule"].strip() for e in errors):
        return set()
    if any(not isinstance(x, str) or not x.strip() for x in limits):
        return set()
    if limits or result.get("truncated"):
        return set()
    errored = {e["rule"] for e in errors}
    if "engine" in errored:
        return set()
    rc = result.get("rules_covered")
    if not isinstance(rc, list) or any(not isinstance(r, str) or not r for r in rc):
        return set()
    return set(rc) - errored


def _skipped_rules(result):
    """Rules that skipped elements (stats.skipped), or None when the field is missing/malformed."""
    stats = result.get("stats")
    sk = stats.get("skipped") if isinstance(stats, dict) else None
    if not isinstance(sk, dict):
        return None
    out = set()
    for rule, v in sk.items():
        if not isinstance(v, dict) or v:
            out.add(rule)
    return out


def _pin_rule(pin_id, finding_raw):
    if isinstance(finding_raw, dict) and finding_raw.get("rule"):
        return str(finding_raw["rule"])
    if isinstance(finding_raw, str) and finding_raw:
        try:
            f = json.loads(finding_raw)
            if isinstance(f, dict) and f.get("rule"):
                return str(f["rule"])
        except (TypeError, ValueError):
            pass
    if isinstance(pin_id, str) and "@" in pin_id:
        return pin_id.split("@", 1)[0]
    return ""


def _present_counts(result):
    """(counts, ok): ok only for a well-formed, complete inventory. Missing or incomplete never closes a pin."""
    pa = result.get("presentAnchors")
    if (not isinstance(pa, list) or any(not isinstance(x, str) for x in pa)
            or result.get("presentComplete") is not True):
        return None, False
    counts = {}
    for x in pa:
        counts[x] = counts.get(x, 0) + 1
    return counts, True


def _pin_sig(finding_raw):
    try:
        f = json.loads(finding_raw) if isinstance(finding_raw, str) else finding_raw
        sig = f.get("anchor", {}).get("sig") if isinstance(f, dict) else None
    except (TypeError, ValueError, AttributeError):
        sig = None
    return sig if isinstance(sig, str) and sig else None


def _pin_options(finding_raw):
    try:
        f = json.loads(finding_raw) if isinstance(finding_raw, str) else finding_raw
        sig = f.get("audit_sig") if isinstance(f, dict) else None
    except (TypeError, ValueError, AttributeError):
        sig = None
    return sig if isinstance(sig, str) and sig else None


def classify_absent(pin_id, finding_raw, ctx):
    """Verdict for an earlier open pin the new audit did not report: 'fixed' | 'gone' | 'not_rechecked'.

    docs/delta-semantics.md, rows 3-10 (first match wins). ctx = {coverage, skipped, present, present_ok, options}.
    """
    rule = _pin_rule(pin_id, finding_raw)
    if not rule or rule not in ctx["coverage"]:
        return "not_rechecked"
    prior = _pin_options(finding_raw)
    if prior is None or ctx["options"] is None or prior != ctx["options"]:
        return "not_rechecked"
    if not ctx["present_ok"]:
        return "not_rechecked"
    sig = _pin_sig(finding_raw)
    if not sig or ctx["present"].get(sig, 0) > 1:
        return "not_rechecked"
    if ctx["present"].get(sig, 0) == 0:
        return "gone"
    if ctx["skipped"] is None or rule in ctx["skipped"]:
        return "not_rechecked"
    return "fixed"


def format_receipt(prev_score, score, fixed, gone, remaining, not_rechecked):
    """Compact pasteable Markdown receipt of a re-audit. Mirrors bridge.js formatReceipt (shared test cases)."""
    def sc(v):
        return "?" if v is None else str(v)
    lines = [f"**Pinpoint receipt** - score {sc(prev_score)} -> {sc(score)}",
             f"- fixed (no longer reported, same element signature still present; NOT re-measured): {len(fixed)}"]
    lines += [f"  - `{i}`" for i in fixed[:10]]
    lines.append(f"- gone (element signature no longer on the page; NOT proof of a fix): {len(gone)}")
    lines += [f"  - `{i}`" for i in gone[:10]]
    lines.append(f"- not rechecked (kept open): {len(not_rechecked)}")
    lines += [f"  - `{i}`" for i in not_rechecked[:10]]
    lines.append(f"- still failing: {remaining}")
    return "\n".join(lines)


def record_audit(result, source="user"):
    """Store one AuditResult; returns {audit_id, delta, url_key, findings(visible), suppressed, score, counts}."""
    try:
        if not isinstance(result, dict):
            return _empty_delta_result("", "")
        url = clean_text(result.get("url"), 500)
        key = url_key(url)
        raw = result.get("findings")
        # Reject unusable reports before opening the store: dropping bad entries
        # (or treating a missing report as []) cannot establish finding absence.
        if not isinstance(raw, list) or any(
                not isinstance(f, dict) or not isinstance(f.get("id"), str)
                or not f["id"].strip() for f in raw):
            return _empty_delta_result(url, key)
        findings = [clean_finding(f) for f in raw]
        opt_sig = options_sig(result.get("audit_options"))
        for f in findings:           # never trust a page-supplied stamp
            f.pop("audit_sig", None)
            if opt_sig:
                f["audit_sig"] = opt_sig
        if not key:
            return {**_empty_delta_result(url, key), "findings": findings}
        score = result.get("score")
        score = int(score) if isinstance(score, (int, float)) and not isinstance(score, bool) else None
        counts = result.get("counts") if isinstance(result.get("counts"), dict) else {}
        now = _now()
        with connect() as c:
            prev_audit = c.execute("select score from audits where url_key=? order by id desc limit 1", (key,)).fetchone()
            pins = {r[0]: (r[1], r[2], r[3], r[4]) for r in c.execute(
                "select id,status,finding,first_seen,reason from pins where url_key=?", (key,))}
            dismissed = {i for i, p in pins.items() if p[0] == "dismissed"}
            visible = [f for f in findings if f["id"] not in dismissed]
            suppressed = len(findings) - len(visible)
            cur = {f["id"] for f in visible}
            prev_open = {i for i, p in pins.items() if p[0] in ("open", "new")}
            present, present_ok = _present_counts(result)
            ctx = {"coverage": _extract_coverage(result), "skipped": _skipped_rules(result),
                   "present": present, "present_ok": present_ok, "options": opt_sig}
            fixed, gone, not_rechecked = [], [], []
            for i in pins:
                if i in prev_open and i not in cur:
                    {"fixed": fixed, "gone": gone, "not_rechecked": not_rechecked}[classify_absent(i, pins[i][1], ctx)].append(i)
            new = [f["id"] for f in visible if f["id"] not in pins]
            remaining = len(cur & prev_open)
            cid = c.execute("insert into audits(url_key,url,t,score,counts,source) values(?,?,?,?,?,?)",
                            (key, url, now, score, json.dumps(counts), clean_text(source, 8))).lastrowid
            for i in fixed:
                c.execute("update pins set status='fixed' where url_key=? and id=?", (key, i))
            for i in gone:
                c.execute("update pins set status='gone' where url_key=? and id=?", (key, i))
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
                delta = {"prev_score": prev_audit[0], "fixed": fixed, "gone": gone, "new": new, "remaining": remaining}
                delta["not_rechecked"] = not_rechecked
                delta["unresolved"] = not_rechecked
                delta["receipt"] = format_receipt(prev_audit[0], score, fixed, gone, remaining, not_rechecked)
            _prune(c, key, not_rechecked)
        return {"audit_id": cid, "delta": delta, "url_key": key, "findings": visible,
                "suppressed": suppressed, "score": score, "counts": counts}
    except Exception:
        return _empty_delta_result("", "")


def _prune(c, key, not_rechecked=()):
    # Keep the bounded store, but do not evict an unresolved old pin in favour
    # of a newly returned truncated batch. At most MAX_PINS old pins exist.
    priority = ""
    if not_rechecked:
        priority = "case when id in (" + ",".join("?" for _ in not_rechecked) + ") then 0 else 1 end, "
    c.execute("delete from pins where url_key=? and id not in "
              "(select id from pins where url_key=? order by " + priority + "last_seen desc, first_seen desc, id limit ?)",
              (key, key, *not_rechecked, MAX_PINS))
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
    # Prune stale audit runs older than MAX_AGE_SECONDS (7 days)
    cutoff = _now() - MAX_AGE_SECONDS
    c.execute("delete from audits where t < ?", (cutoff,))
    c.execute("delete from pins where last_seen < ?", (cutoff,))


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
