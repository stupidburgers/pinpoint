import sys, time, json
from cdp import C
c = C()
text = open(sys.argv[1], encoding="utf8").read()
print(c.eval("""(() => { const el = document.querySelector('[data-slot="composer-rich-input"]'); if(!el) return 'NO EDITOR'; el.focus(); return el.className + ' ' + el.tagName })()"""))
c.call("Input.insertText", text=text)
time.sleep(0.5)
for t in ("rawKeyDown", "keyUp"):
    c.call("Input.dispatchKeyEvent", type=t, key="Enter", code="Enter", windowsVirtualKeyCode=13, nativeVirtualKeyCode=13)
print("sent")
