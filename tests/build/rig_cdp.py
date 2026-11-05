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
