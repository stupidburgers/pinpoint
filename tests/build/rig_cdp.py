"""Tiny CDP helper for the spike (websocket-client). usage: python cdp.py eval "<js>" | shot <png>"""
import json, sys, base64, urllib.request, websocket

import os
PORT = int(os.environ.get("PP_CDP_PORT", "9445"))

def page_ws():
    tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
    return [t for t in tabs if t["type"] == "page"][0]["webSocketDebuggerUrl"]

class C:
    def __init__(self):
        self.ws = websocket.create_connection(page_ws(), max_size=None, suppress_origin=True)
        self.i = 0
    def call(self, method, **params):
        self.i += 1
        self.ws.send(json.dumps({"id": self.i, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self.i:
                return m
    def eval(self, js):
        r = self.call("Runtime.evaluate", expression=js, returnByValue=True, awaitPromise=True)
        res = r.get("result", {})
        if "exceptionDetails" in res:
            return {"EXC": res["exceptionDetails"].get("exception", {}).get("description", str(res["exceptionDetails"]))}
        return res.get("result", {}).get("value")
    def shot(self, path):
        r = self.call("Page.captureScreenshot", format="png")
        open(path, "wb").write(base64.b64decode(r["result"]["data"]))

if __name__ == "__main__":
    c = C()
    if sys.argv[1] == "eval":
        v = c.eval(sys.argv[2]); print(json.dumps(v, indent=1) if not isinstance(v, str) else v)
    elif sys.argv[1] == "shot":
        c.shot(sys.argv[2]); print("saved", sys.argv[2])


def press(c, key, code=None, vk=0, mods=0):
    """Dispatch a key press: mods bitmask alt=1 ctrl=2 meta=4 shift=8."""
    code = code or key
    for t in ("rawKeyDown", "keyUp"):
        c.call("Input.dispatchKeyEvent", type=t, key=key, code=code, windowsVirtualKeyCode=vk, nativeVirtualKeyCode=vk, modifiers=mods)


def palette(c, text, enter=True):
    """Open the command palette (Ctrl+K), type, optionally Enter."""
    press(c, "k", "KeyK", 75, 2)
    import time; time.sleep(0.5)
    c.call("Input.insertText", text=text)
    time.sleep(0.6)
    if enter:
        press(c, "Enter", "Enter", 13)


def browse(c, url):
    """Type a URL into the Browser pane address bar and press Enter."""
    import time
    c.eval("(()=>{const i=document.querySelector('input[placeholder=\"Enter address\"]'); i.focus(); i.select(); return 1})()")
    c.call("Input.insertText", text=url)
    time.sleep(0.2)
    press(c, "Enter", "Enter", 13)


def advanced_layout(c):
    """Layout editor -> Interface mode 'Advanced' -> Done. Contributed panes (Pinpoint) only appear in Advanced mode."""
    import time
    c.eval("(()=>{document.querySelector('button[aria-label=\"Layout editor\"]').click();return 1})()"); time.sleep(0.8)
    c.eval("(()=>{const b=[...document.querySelectorAll('button')].find(b=>/^Advanced/.test(b.textContent.trim())); if(b) b.click(); return !!b})()"); time.sleep(0.6)
    c.eval("(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Done').click();return 1})()"); time.sleep(0.8)


def click_text(c, text, tag='button'):
    return c.eval("(()=>{const t=[...document.querySelectorAll('%s')].find(b=>b.textContent.trim()===%r); if(t) t.click(); return !!t})()" % (tag, text))
