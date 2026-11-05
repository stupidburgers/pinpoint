"""Engine test harness: real Chromium via playwright, engine injected as source."""
import json
import pathlib

import pytest
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
ENGINE = HERE.parent.parent / "engine" / "pinpoint-engine.js"
FIXTURES = HERE / "fixtures"
LABELED = HERE / "labeled"


def engine_source():
    return ENGINE.read_text(encoding="utf-8").strip().rstrip(";")


def inject_js(config="{}"):
    return "(" + engine_source() + ")(" + config + ")"


class PP:
    """Thin wrapper: page.pp.audit(opts) etc. call window.__pinpoint in the page."""

    def __init__(self, page):
        self.page = page

    def call(self, method, *args):
        return self.page.evaluate(
            "([m,a]) => window.__pinpoint[m](...a)", [method, list(args)]
        )

    def audit(self, opts=None):
        return self.call("audit", opts or {})

    def refs(self, rule, opts=None):
        """Set of anchor.ref (id attr) of findings for one rule."""
        o = dict(opts or {})
        o["rules"] = [rule]
        res = self.audit(o)
        assert not res["errors"], res["errors"]
        return {f["anchor"]["ref"] for f in res["findings"] if f["rule"] == rule}

    def inject(self, config="{}"):
        self.page.evaluate(inject_js(config))


@pytest.fixture(scope="session")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture()
def load(browser):
    pages = []

    def _load(name, viewport=(800, 600), config=None, folder=None, inject=True):
        ctx = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]})
        pages.append(ctx)
        page = ctx.new_page()
        base = folder or FIXTURES
        page.goto((base / (name + ".html")).as_uri())
        page.wait_for_load_state("load")
        page.pp = PP(page)
        if inject:
            page.pp.inject(json.dumps(config or {}))
        return page

    yield _load
    for c in pages:
        c.close()


@pytest.fixture()
def blank(browser):
    """Page from inline html."""
    ctxs = []

    def _blank(html, viewport=(800, 600), config=None, inject=True):
        ctx = browser.new_context(viewport={"width": viewport[0], "height": viewport[1]})
        ctxs.append(ctx)
        page = ctx.new_page()
        page.set_content(html)
        page.pp = PP(page)
        if inject:
            page.pp.inject(json.dumps(config or {}))
        return page

    yield _blank
    for c in ctxs:
        c.close()
