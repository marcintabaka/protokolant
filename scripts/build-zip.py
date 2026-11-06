#!/usr/bin/env python3
"""Buduje paczkę ZIP dodatku do wysłania do Chrome Web Store.

Użycie:  python3 scripts/build-zip.py [--skip-tests] [--force]

Kroki:
 1. sprawdza manifest (JSON, wymagane pola, długość nazwy i opisu),
 2. sprawdza, czy istnieją wszystkie pliki, do których odwołują się manifest,
    popup.html i kod (ikony stanów),
 3. sprawdza składnię plików JS (node --check) i niechciane treści,
 4. uruchamia testy z tests/ (pomiń: --skip-tests),
 5. pilnuje podbicia wersji: nie nadpisuje istniejącej paczki tej samej wersji (wymuś: --force),
 6. pakuje extension/ do dist/protokolant-<wersja>.zip (manifest w katalogu głównym paczki),
 7. kopiuje paczkę do katalogu COPY_DIR z pliku .local.env (opcjonalnie, poza repozytorium).

Dodatkowe zakazane słowa (np. nazwy, które nie powinny trafić do publicznej paczki) można dopisać
w pliku .forbidden-words w katalogu głównym (jedno wyrażenie regularne w wierszu, plik poza gitem).
"""
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / 'extension'
DIST = ROOT / 'dist'


def local_env():
    """Czyta lokalne ustawienia KEY=wartość z .local.env (poza gitem)."""
    env = {}
    p = ROOT / '.local.env'
    if p.exists():
        for line in p.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


LOCAL = local_env()
COPY_DIR = Path(LOCAL['COPY_DIR']) if LOCAL.get('COPY_DIR') else None

TESTS = [
    'tests/format.test.js',
    'tests/chat-frame.sim.js',
    'tests/inject.sim.js',
    'tests/inject.foreign.sim.js',
    'tests/content.sim.js',
]
# Treści, które nie powinny trafić do publicznej paczki.
FORBIDDEN = [r'\bdebugger\b', r'localhost']
_fw = ROOT / '.forbidden-words'
if _fw.exists():
    FORBIDDEN += [l.strip() for l in _fw.read_text(encoding='utf-8').splitlines() if l.strip() and not l.startswith('#')]
ALLOWED_EXT = {'.js', '.json', '.html', '.png', '.css'}

errors = []


def fail(msg):
    errors.append(msg)
    print(f'  ✖ {msg}')


def ok(msg):
    print(f'  ✔ {msg}')


def check_manifest():
    print('Manifest')
    m = json.loads((EXT / 'manifest.json').read_text(encoding='utf-8'))
    for key in ['manifest_version', 'name', 'version', 'description', 'icons', 'action']:
        if key not in m:
            fail(f'brak pola {key}')
    if m.get('manifest_version') != 3:
        fail('manifest_version musi być 3')
    if len(m.get('name', '')) > 75:
        fail(f'nazwa ma {len(m["name"])} znaków (limit 75)')
    if len(m.get('description', '')) > 132:
        fail(f'opis ma {len(m["description"])} znaków (limit 132)')
    if not re.fullmatch(r'\d+(\.\d+){0,3}', m.get('version', '')):
        fail(f'niepoprawny numer wersji: {m.get("version")}')
    if '128' not in m.get('icons', {}):
        fail('brak ikony 128 px (wymagana przez sklep)')
    ok(f'{m["name"]} {m["version"]}')
    return m


def referenced_files(m):
    refs = {'manifest.json'} | set(m.get('icons', {}).values())
    refs |= set(m.get('action', {}).get('default_icon', {}).values())
    if m.get('action', {}).get('default_popup'):
        refs.add(m['action']['default_popup'])
    if m.get('background', {}).get('service_worker'):
        refs.add(m['background']['service_worker'])
    for cs in m.get('content_scripts', []):
        refs |= set(cs.get('js', [])) | set(cs.get('css', []))
    # skrypty z popup.html
    popup = EXT / m.get('action', {}).get('default_popup', 'popup.html')
    if popup.exists():
        refs |= set(re.findall(r'<script[^>]+src="([^"]+)"', popup.read_text(encoding='utf-8')))
    # importScripts w service workerze
    sw = EXT / m.get('background', {}).get('service_worker', '')
    if sw.is_file():
        for group in re.findall(r"importScripts\(([^)]*)\)", sw.read_text(encoding='utf-8')):
            refs |= set(re.findall(r"'([^']+)'", group))
    # ikony stanów ustawiane w kodzie (background.js: icons/<stan>-<rozmiar>.png)
    for st in ['idle', 'rec', 'dim', 'warn']:
        for size in [16, 32]:
            refs.add(f'icons/{st}-{size}.png')
    return refs


def check_files(m):
    print('Pliki')
    refs = referenced_files(m)
    for r in sorted(refs):
        if not (EXT / r).is_file():
            fail(f'brak pliku: {r}')
    files = sorted(p for p in EXT.rglob('*') if p.is_file())
    for p in files:
        rel = p.relative_to(EXT).as_posix()
        if p.suffix not in ALLOWED_EXT:
            fail(f'nieoczekiwany plik w paczce: {rel}')
        elif rel not in refs:
            print(f'  ! plik nieużywany przez manifest/popup: {rel}')
    ok(f'{len(files)} plików, odwołania z manifestu i kodu: {len(refs)}')
    return files


def check_code(files):
    print('Kod')
    for p in files:
        if p.suffix == '.js':
            r = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
            if r.returncode:
                fail(f'błąd składni {p.name}: {r.stderr.strip()[:200]}')
        if p.suffix in {'.js', '.json', '.html', '.css'}:
            text = p.read_text(encoding='utf-8')
            for pat in FORBIDDEN:
                for mt in re.finditer(pat, text, re.I):
                    line = text.count('\n', 0, mt.start()) + 1
                    fail(f'niechciana treść „{mt.group(0)}” w {p.relative_to(EXT)}:{line}')
    ok('składnia JS i treść sprawdzone')


def run_tests():
    print('Testy')
    for t in TESTS:
        r = subprocess.run(['node', t], cwd=ROOT, capture_output=True, text=True, timeout=180)
        out = r.stdout + r.stderr
        n_ok = len(re.findall(r'^OK', out, re.M))
        bad = re.findall(r'^FAIL.*', out, re.M)
        if r.returncode or bad:
            fail(f'{t}: {len(bad)} błędów' + (f' – {bad[0][:150]}' if bad else ''))
        else:
            ok(f'{t}: {n_ok} OK')


def build(m, files, force):
    print('Paczka')
    DIST.mkdir(exist_ok=True)
    out = DIST / f'protokolant-{m["version"]}.zip'
    if out.exists() and not force:
        fail(f'{out.name} już istnieje – podbij wersję w manifest.json (albo użyj --force)')
        return None
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in files:
            info = zipfile.ZipInfo(p.relative_to(EXT).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, p.read_bytes())
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        if 'manifest.json' not in names:
            fail('manifest.json nie jest w katalogu głównym paczki')
    ok(f'{out.relative_to(ROOT)} ({out.stat().st_size / 1024:.1f} KB, {len(names)} plików)')
    return out


def main():
    skip_tests = '--skip-tests' in sys.argv
    force = '--force' in sys.argv
    m = check_manifest()
    files = check_files(m)
    check_code(files)
    if not skip_tests:
        run_tests()
    if errors:
        print(f'\nPRZERWANO: {len(errors)} problemów, paczka nie została zbudowana.')
        sys.exit(1)
    out = build(m, files, force)
    if errors or not out:
        sys.exit(1)
    if COPY_DIR and COPY_DIR.parent.exists():
        COPY_DIR.mkdir(exist_ok=True)
        shutil.copy2(out, COPY_DIR / out.name)
        print(f'  ✔ skopiowano do {COPY_DIR / out.name}')
    print('\nGotowe.')


if __name__ == '__main__':
    main()
