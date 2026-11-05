"""Derive demo/site/fixed/* and demo/fixes/* from demo/site/{index.html,styles.css}.

The fixes are defined ONCE here as exact string replacements in three steps. Outputs:
  demo/site/fixed/index.html, fixed/styles.css   (all steps applied; refs ../app.js ../assets)
  demo/fixes/01-contrast.patch, 02-css-layout.patch, 03-html.patch   (unified diffs, `git apply` from demo/site)
  demo/fixes/fixes.json   (same edits as {path, old_string, new_string}: what the fake LLM sends to the `patch` tool)
Run:  python demo/fixes/build.py        (idempotent; test_site_truth checks it is up to date)
"""
import difflib
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, '..', 'site')

STEPS = [
    ('01-contrast', 'Raise the two low-contrast text colours to >= 4.5:1', [
        ('styles.css', 'color: #b8ad9f; }', 'color: var(--ink-soft); }'),
        ('styles.css', '.plan .price-note { color: #978a7b; }', '.plan .price-note { color: #6b5a4c; }'),
    ]),
    ('02-css-layout', 'Targets 44 px, readable type, focus ring, no horizontal overflow', [
        ('styles.css', '/* FLAW 12: removes the focus ring with no replacement */\n.nav a { outline: none; }\n', ''),
        ('styles.css', 'width: 18px; height: 18px; padding: 0;', 'width: 44px; height: 44px; padding: 0;'),
        ('styles.css', 'gap: 2px; margin-top: 36px; }', 'gap: 12px; margin-top: 36px; }'),
        ('styles.css', '.fav { margin-left: 1px; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px;',
                       '.fav { margin-left: 12px; display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px;'),
        ('styles.css', '.tag-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 40px; }', '.tag-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 40px; }'),
        ('styles.css', 'height: 20px; padding: 0 10px; border: 1px solid var(--ink-soft); border-radius: 10px;', 'min-height: 44px; padding: 0 18px; border: 1px solid var(--ink-soft); border-radius: 22px;'),
        ('styles.css', '.tight p { line-height: 1; }', '.tight p { line-height: 1.6; }'),
        ('styles.css', '.fine { font-size: 10.5px; }', '.fine { font-size: 0.8125rem; }'),
        ('styles.css', 'width: 1600px; padding: 18px 40px;', 'flex-wrap: wrap; gap: 8px 24px; max-width: 100%; padding: 18px var(--gutter);'),
    ]),
    ('03-html', 'lang, alt text, labels, accessible names, heading order', [
        ('index.html', '<html id="top">', '<html id="top" lang="en">'),
        ('index.html', '<button id="menu-btn" class="icon-btn" type="button">', '<button id="menu-btn" class="icon-btn" type="button" aria-label="Open menu">'),
        ('index.html', '<img id="hero-img" src="assets/hero.svg" width="960" height="1080">',
                       '<img id="hero-img" src="assets/hero.svg" width="960" height="1080" alt="A white cup of black coffee steaming on a table covered in roasted beans">'),
        ('index.html', 'alt="IMG_2041.jpg"', 'alt="Ines, Tomas and Priya standing behind the roaster"'),
        ('index.html', '<input id="email" name="email" type="email" placeholder="Email address" autocomplete="email">',
                       '<label for="email">Email address</label>\n        <input id="email" name="email" type="email" placeholder="you@example.com" autocomplete="email">'),
        ('index.html', '<h4 id="plan-starter">Starter</h4>', '<h3 id="plan-starter">Starter</h3>'),
        ('index.html', '<h4>Regular</h4>', '<h3>Regular</h3>'),
        ('index.html', '<h4>Household</h4>', '<h3>Household</h3>'),
    ]),
]
# styles.css has `.plan h4` rules; the fixed step renames them together with the html step
EXTRA_CSS_IN_STEP_3 = ('styles.css', '.plan h4 { font-size: 1.75rem; }', '.plan h3 { font-size: 1.75rem; }')
STEPS[2][2].append(EXTRA_CSS_IN_STEP_3)


def read(p):
    # Literal "\r\n"/"\n": the install scanner (plugin-guard, `chr_building`) treats
    # chr(N)+chr(N) chains as obfuscation; this is plain CRLF normalisation.
    with open(p, encoding='utf8', newline='') as f:
        return f.read().replace("\r\n", "\n")


def write(p, s):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf8', newline='') as f:
        f.write(s)


def build():
    files = {n: read(os.path.join(SITE, n)) for n in ('index.html', 'styles.css')}
    cur = dict(files)
    flat = []
    for name, title, edits in STEPS:
        before = dict(cur)
        for fn, old, new in edits:
            assert cur[fn].count(old) == 1, (name, fn, old[:60], cur[fn].count(old))
            cur[fn] = cur[fn].replace(old, new)
            flat.append({'step': name, 'path': fn, 'old_string': old, 'new_string': new})
        diff = ''
        for fn in ('index.html', 'styles.css'):
            if before[fn] != cur[fn]:
                diff += ''.join(difflib.unified_diff(before[fn].splitlines(True), cur[fn].splitlines(True), 'a/' + fn, 'b/' + fn))
        write(os.path.join(HERE, name + '.patch'), diff)
    fixed_html = cur['index.html'].replace('href="styles.css"', 'href="styles.css"').replace('src="app.js"', 'src="../app.js"')
    fixed_html = fixed_html.replace('src="assets/', 'src="../assets/')
    write(os.path.join(SITE, 'fixed', 'index.html'), fixed_html)
    write(os.path.join(SITE, 'fixed', 'styles.css'), cur['styles.css'])
    write(os.path.join(HERE, 'fixes.json'), json.dumps({'steps': [{'name': n, 'title': t} for n, t, _ in STEPS], 'edits': flat}, indent=1, ensure_ascii=False))
    return cur


if __name__ == '__main__':
    build()
    print('built fixed/ and fixes/*.patch + fixes.json')
