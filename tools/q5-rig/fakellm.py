import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
LOG = open(sys.argv[2], "a", encoding="utf-8")
def log(o): LOG.write(json.dumps(o)[:6000] + "\n"); LOG.flush()
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.endswith("/models"):
            b = json.dumps({"object": "list", "data": [{"id": "fake-1", "object": "model"}]}).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
        else:
            self.send_response(404); self.end_headers()
    def do_POST(self):
        n = int(self.headers.get("content-length", 0)); req = json.loads(self.rfile.read(n) or b"{}")
        msgs = req.get("messages", []); tools = [t["function"]["name"] for t in req.get("tools", []) if "function" in t]
        last = msgs[-1] if msgs else {}
        def text(m):
            c = m.get("content")
            return c if isinstance(c, str) else " ".join(p.get("text", "") for p in (c or []) if isinstance(p, dict))
        lt = text(last)
        log({"t": time.time(), "stream": req.get("stream"), "ntools": len(tools), "has_pinpoint_probe": "pinpoint_probe" in tools, "tools_sample": [x for x in tools if "pin" in x or "tool_" in x], "last_role": last.get("role"), "last_len": len(lt), "last_tail": lt[-200:], "last_text": lt[:300], "tool_desc": next((t["function"]["description"][:1500] for t in req.get("tools", []) if t["function"]["name"]=="tool_search"), None)})
        tc = None; content = None
        if last.get("role") == "tool":
            content = "Probe done. ::pinpoint{n=\"3\" kind=\"contrast\"}"
        elif "RUNPROBE" in lt and "tool_call" in tools:
            tc = {"id": "call_1", "type": "function", "function": {"name": "tool_call", "arguments": json.dumps({"calls": [{"name": "pinpoint_probe", "arguments": {"label": "from-fake-llm", "n": int((__import__("re").search(r"n=(\d+)", lt) or [0,3])[1])}}]})}}
        elif "RUNPROBE" in lt and "pinpoint_probe" in tools:
            tc = {"id": "call_1", "type": "function", "function": {"name": "pinpoint_probe", "arguments": json.dumps({"label": "from-fake-llm"})}}
        else:
            content = "ack: " + lt[:120]
        if req.get("stream"):
            self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
            def ch(delta, fin=None): 
                self.wfile.write(("data: " + json.dumps({"id": "c1", "object": "chat.completion.chunk", "model": "fake-1", "choices": [{"index": 0, "delta": delta, "finish_reason": fin}]}) + "\n\n").encode()); self.wfile.flush()
            ch({"role": "assistant"})
            if tc: ch({"tool_calls": [{"index": 0, **tc}]}); ch({}, "tool_calls")
            else: ch({"content": content}); ch({}, "stop")
            self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
        else:
            msg = {"role": "assistant", "content": content}
            if tc: msg["tool_calls"] = [tc]
            b = json.dumps({"id": "c1", "object": "chat.completion", "model": "fake-1", "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if tc else "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
