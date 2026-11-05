"""B8: precision/recall over the labeled corpus in tests/engine/labeled/.

Label convention: element id "<bad|ok>-<scope><n>" on every checked element.
Scope letters map to rules below. Precision/recall count ONLY labeled elements.
The report is written to docs/metrics.md by this test (kept in sync with the engine).
"""
import re
from collections import defaultdict

from conftest import LABELED

SCOPE = {
    "c": "a11y.contrast", "t": "a11y.tap-target", "i": "a11y.img-alt", "l": "a11y.form-label",
    "n": "a11y.control-name", "h": "a11y.heading-order", "f": "a11y.focus-indicator",
    "m": "a11y.lang", "p": "a11y.page-title", "v": "a11y.viewport-zoom",
    "o": "layout.h-overflow", "s": "type.text-small", "g": "type.line-height", "x": "spacing.tight-targets",
}
ID_RE = re.compile(r'id="((?:bad|ok)-[a-z]\d+)"')

PAGE_VIEWPORT = {"cards.html": (800, 600)}  # cards is wide enough on its own


def collect_corpus():
    """{file: {element_id: ('bad'|'ok', rule)}}"""
    corpus = {}
    for f in sorted(LABELED.glob("*.html")):
        els = {}
        for m in ID_RE.finditer(f.read_text(encoding="utf-8")):
            eid = m.group(1)
            kind = eid.split("-")[0]
            els[eid] = (kind, SCOPE[eid.split("-")[1][0]])
        corpus[f.name] = els
    return corpus


CORPUS = collect_corpus()


def test_corpus_size_and_coverage():
    n = sum(len(v) for v in CORPUS.values())
    assert n >= 120, f"only {n} labeled elements"
    rules = {r for els in CORPUS.values() for _, r in els.values()}
    assert rules == set(SCOPE.values()), sorted(set(SCOPE.values()) - rules)


def _report(browser, writer=None):
    rows = {}
    findings_detail = defaultdict(list)
    for fname, els in CORPUS.items():
        ctx = browser.new_context(viewport={"width": 800, "height": 600})
        page = ctx.new_page()
        page.goto((LABELED / fname).as_uri())
        page.wait_for_load_state("load")
        from conftest import PP, inject_js
        if fname == "tap-hard.html":
            page.wait_for_timeout(100)  # shadow root script + iframe
        page.pp = PP(page)
        page.pp.inject()
        res = page.pp.audit({"tapAdvisory": 0, "maxFindings": 200})
        assert res["errors"] == [], res["errors"]
        by_rule = defaultdict(set)
        for f in res["findings"]:
            by_rule[f["rule"]].add(f["anchor"]["ref"])
            if f["anchor"]["ref"]:
                findings_detail[(fname, f["rule"])].append(f["anchor"]["ref"])
        sums = rows
        for eid, (kind, rule) in els.items():
            t = sums.setdefault(rule, [0, 0, 0, 0])  # tp fp tn fn
            hit = eid in by_rule[rule]
            if kind == "bad" and hit:
                t[0] += 1
            elif kind == "bad" and not hit:
                t[3] += 1
            elif kind == "ok" and hit:
                t[1] += 1
            else:
                t[2] += 1
        ctx.close()
    return rows


def test_precision_recall(browser, tmp_path_factory):
    rows = _report(browser)
    total_labeled = sum(len(v) for v in CORPUS.values())
    lines = [
        "# Pinpoint engine - labeled-set metrics",
        "",
        "Corpus: `tests/engine/labeled/` (%d HTML pages, **%d labeled elements**), Chromium %s."
        "" % (len(CORPUS), total_labeled, browser.version),
        "Labels are hand-written (`bad-*` = must be flagged, `ok-*` = must not) for each rule; the rule set is ours.",
        "Run: `env -u PYTHONPATH python -m pytest tests/engine/test_metrics.py` regenerates this file.",
        "Audit options: defaults except `tapAdvisory: 0` (advisory sizes off).",
        "",
        "| rule | TP | FP | TN | FN | precision | recall |",
        "|---|---|---|---|---|---|---|",
    ]
    problems = []
    for rule in sorted(rows):
        tp, fp, tn, fn = rows[rule]
        p = tp / (tp + fp) if tp + fp else 1.0
        r = tp / (tp + fn) if tp + fn else 1.0
        lines.append(f"| {rule} | {tp} | {fp} | {tn} | {fn} | {p:.2f} | {r:.2f} |")
        if p < 0.95 or r < 0.9:
            problems.append((rule, p, r, rows[rule]))
    tp = sum(v[0] for v in rows.values())
    fp = sum(v[1] for v in rows.values())
    tn = sum(v[2] for v in rows.values())
    fn = sum(v[3] for v in rows.values())
    lines.append(f"| **all** | {tp} | {fp} | {tn} | {fn} | {tp / (tp + fp) if tp + fp else 1:.2f} | {tp / (tp + fn) if tp + fn else 1:.2f} |")
    lines += ["",
              "Notes:",
              "- Contrast skips (background images/gradients/pages with overlapping layers) are reported in `limits`, never guessed: those elements are labeled `ok` so they must stay silent.",
              "- `a11y.focus-indicator` is a static CSSOM heuristic (confidence medium) - it cannot see runtime focus handlers by design.",
              "- Page-level rules (lang/title/viewport) have one labeled element per tiny page.",
              "- Acceptance gates: precision >= 0.95 and recall >= 0.90 per rule on this set.",
              ]
    out = LABELED.parents[2] / "docs" / "metrics.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    assert not problems, problems
