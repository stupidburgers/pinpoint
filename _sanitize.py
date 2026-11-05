"""Sanitisation of page-originated strings and result size capping (SPEC 4.4)."""
import copy
import json
import re

# C0 (keeping nothing), DEL, C1, bidi embedding/override/isolate controls, zero-width/BOM.
_CTRL = re.compile("[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]")
_WS = re.compile(r"\s+")
_SEL_OK = re.compile(r"""^[\w#.\-:>\[\]="'()*~+,/ ]*$""", re.ASCII)
_MEASURED_KEEP = ("ratio", "need", "fg", "bg", "w", "h", "min", "px", "gap", "over", "vw")


def dumps(obj):
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False, default=str)


_PROMPT_DELIMS = re.compile(
    r"<\s*/?\s*(?:system|assistant|user|hermes|control|prompt)[^>]*>|"
    r"\[\s*/?\s*(?:USER_MESSAGE|SYSTEM|ASSISTANT|OUT-OF-BAND)[^\]]*\]|"
    r"<!--[\s\S]*?-->",
    re.IGNORECASE,
)


# Neutralize potential LLM prompt-breakout delimiters in page-originated strings
_PROMPT_DELIMS = re.compile(
    r'<\s*/?\s*(?:system|assistant|user|hermes|control|prompt)[^>]*>|'
    r'\[\s*/?\s*(?:USER_MESSAGE|SYSTEM|ASSISTANT|OUT-OF-BAND)[^\]]*\]|'
    r'<!--[\s\S]*?-->',
    re.IGNORECASE,
)

def clean_text(s, cap):
    """Strip control/bidi chars, delimiters, collapse whitespace, hard-cap to `cap` chars."""
    if isinstance(s, bool) or s is None:
        return ""
    if isinstance(s, (int, float)):
        s = str(s)
    if not isinstance(s, str):
        return ""
    s = _PROMPT_DELIMS.sub(" ", s)
    s = _WS.sub(" ", _CTRL.sub("", s.replace("\t", " ").replace("\n", " ").replace("\r", " "))).strip()
    return s[: max(0, int(cap))]


def clean_selector(s):
    """Selector charset per SPEC 4.1, max 200; anything outside the charset -> ''."""
    s = clean_text(s, 200)
    return s if _SEL_OK.match(s) else ""


def _size(o):
    return len(dumps(o))


def _each_finding(o, fn):
    for f in o.get("findings") or []:
        if isinstance(f, dict):
            fn(f)


def cap_result(obj, limit=12000):
    """Fit `obj` (JSON-able) in `limit` chars. Drop order: rect, anchor, measured extras,
    findings from the end (truncated=true), then bulky secondary fields."""
    try:
        if not isinstance(obj, dict) or _size(obj) <= limit:
            return obj
        o = copy.deepcopy(obj)
        for key in ("rect", "anchor"):
            _each_finding(o, lambda f, k=key: f.pop(k, None))
            if _size(o) <= limit:
                return o

        def trim(f):
            m = f.get("measured")
            if isinstance(m, dict):
                f["measured"] = {k: v for k, v in m.items() if k in _MEASURED_KEEP}

        _each_finding(o, trim)
        if _size(o) <= limit:
            return o
        fs = o.get("findings")
        if isinstance(fs, list):
            while fs and _size(o) > limit:
                fs.pop()
                o["truncated"] = True
            if _size(o) <= limit:
                return o
        for key in ("limits", "delta", "counts"):
            o.pop(key, None)
            if _size(o) <= limit:
                return o
        slim = {k: o[k] for k in ("ok", "code", "audit_id", "score") if k in o}
        slim["truncated"] = True
        return slim
    except Exception:  # never raise
        return {"ok": False, "code": "engine_error", "message": "result too large"}
