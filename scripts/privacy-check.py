#!/usr/bin/env python3
"""Scan every tracked text file, without evidence/docs exemptions.

Reads working-tree contents for precommit use. Binary images are not privacy
reviewed by this gate. Reports locations/categories, never the private value.
"""
import re
import subprocess
import sys
from pathlib import Path


def reasons(text):
    normalized = re.sub(r'[\\/]+', '/', text)
    hits = []
    if re.search(r'(?i)(?:[a-z]:/users/|/(?:home|users)/)[a-z0-9_.-]+(?:/|\b)', normalized):
        hits.append('user-home path')
    if re.search(r'(?i)\blocal-[0-9a-f]{8,}\b|\b20\d{6}_\d{6}_[0-9a-f]{6,}\b', text):
        hits.append('captured session identity')
    return hits


def main():
    # --tracked-stdin accepts NUL-delimited `git ls-files -z` from the shell,
    # including on Windows where a bundled Git may not be spawnable by Python.
    if sys.argv[1:] == ['--tracked-stdin']:
        root = Path.cwd()
        paths = sys.stdin.buffer.read().decode('utf-8').split('\0')
    else:
        root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
        paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode('utf-8').split('\0')
    fail = False
    count = 0
    for name in filter(None, paths):
        if name == '.hermes.md':
            print('PRIVACY FAIL: .hermes.md: tracked private instruction file')
            fail = True
        path = root / name
        if not path.is_file():
            continue  # pending deletion
        data = path.read_bytes()
        if b'\0' in data:
            continue
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            continue
        count += 1
        for number, line in enumerate(text.splitlines(), 1):
            for reason in reasons(line):
                print(f'PRIVACY FAIL: {name}:{number}: {reason}')
                fail = True
    if not fail:
        print(f'privacy ok ({count} tracked text files; binary images not reviewed)')
    return int(fail)


if __name__ == '__main__':
    sys.exit(main())
