#!/usr/bin/env python3
"""
道路圖層同步檢查 —— data/tiles/ ←— Taiwanwonnerf

這個 repo 的四個道路圖層產出物並非在此產生，而是從 Taiwanwonnerf 複製過來：

    hierarchy.pmtiles              道路功能層級（Sustainable Safety：Through／Distributor／Access）
    living_streets.pmtiles         生活街道候選（估算路寬 ≤15 m，分級 A／B／C）
    hierarchy_stats.json           道路功能層級的長度統計（圖例用）
    living_streets_summary.json    生活街道候選的長度統計（圖例用）
    county_stats.json              各縣市統計

處理流程只在 Taiwanwonnerf 維護（scripts/01_extract_roads.py → 02_build_tiles.sh
→ 03_export_shp.py → 04_county_split.py → 05_hierarchy.py），本 repo 不重做一份。
https://github.com/yunching0513/202609---Taiwanwonnerf

問題在於那份複製一直是手動的。兩邊今天一致，但只要在 Taiwanwonnerf 重跑一次
02_build_tiles.sh，這裡的副本就會悄悄過期，沒有任何東西會提醒。這支腳本就是那個提醒。

注意其中一個檔名兩邊不同（手動複製最容易弄錯的一項）：

    Taiwanwonnerf  docs/summary.json   →   schoolzone  data/tiles/living_streets_summary.json

用法：

    python3 scripts/sync_tiles.py                 # 只檢查，不動任何檔案
    python3 scripts/sync_tiles.py --apply         # 檢查後把不一致的檔案複製過來
    python3 scripts/sync_tiles.py --source ~/path/to/Taiwanwonnerf

離開代碼：0＝一致，1＝有漂移，2＝找不到來源 repo。
（所以可以直接放進 CI 或 pre-commit 當檢查用。）

只使用 Python 標準函式庫，不需要安裝任何套件。
"""
import argparse
import hashlib
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, '..'))
DEST_DIR = os.path.join(REPO, 'data', 'tiles')

# (Taiwanwonnerf 內的相對路徑, 本 repo data/tiles/ 內的檔名)
FILES = [
    ('docs/tiles/hierarchy.pmtiles',      'hierarchy.pmtiles'),
    ('docs/tiles/living_streets.pmtiles', 'living_streets.pmtiles'),
    ('docs/hierarchy_stats.json',         'hierarchy_stats.json'),
    ('docs/summary.json',                 'living_streets_summary.json'),
    ('docs/county_stats.json',            'county_stats.json'),
]

# 找來源 repo 的順序：--source → 環境變數 → 以下候選路徑
CANDIDATES = [
    '~/202609 - Taiwanwonnerf',
    '~/Taiwanwonnerf',
    os.path.join(REPO, '..', '202609 - Taiwanwonnerf'),
    os.path.join(REPO, '..', 'Taiwanwonnerf'),
]

# 來源 repo 必須長這樣，才不會把隨便一個資料夾當成它
MARKERS = ['scripts/05_hierarchy.py', 'docs/tiles/hierarchy.pmtiles']


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def looks_like_source(path):
    return all(os.path.exists(os.path.join(path, m)) for m in MARKERS)


def find_source(explicit):
    tried = []
    if explicit:
        p = os.path.abspath(os.path.expanduser(explicit))
        if not os.path.isdir(p):
            return None, [f'{p}（不存在）']
        if not looks_like_source(p):
            return None, [f'{p}（存在，但沒有 {MARKERS[0]}，不像 Taiwanwonnerf）']
        return p, []
    env = os.environ.get('TAIWANWONNERF')
    for cand in ([env] if env else []) + CANDIDATES:
        p = os.path.abspath(os.path.expanduser(cand))
        if looks_like_source(p):
            return p, []
        tried.append(p)
    return None, tried


def human(n):
    return f'{n:,} bytes'


def main():
    ap = argparse.ArgumentParser(
        description='檢查 data/tiles/ 是否與 Taiwanwonnerf 的產出一致；加 --apply 才會複製。')
    ap.add_argument('--apply', action='store_true',
                    help='把不一致的檔案從來源複製過來（預設只檢查、不動檔案）')
    ap.add_argument('--source', metavar='PATH',
                    help='Taiwanwonnerf repo 的路徑（預設自動尋找，也可用環境變數 TAIWANWONNERF）')
    args = ap.parse_args()

    src, tried = find_source(args.source)
    if src is None:
        print('✗ 找不到 Taiwanwonnerf repo。試過：')
        for t in tried:
            print(f'    {t}')
        print('\n  用 --source 指定路徑，或設環境變數 TAIWANWONNERF。')
        print('  repo： https://github.com/yunching0513/202609---Taiwanwonnerf')
        return 2

    print(f'來源  {src}')
    print(f'目的  {DEST_DIR}\n')

    drift, missing, same = [], [], []
    for rel, name in FILES:
        s = os.path.join(src, rel)
        d = os.path.join(DEST_DIR, name)
        label = name if rel.endswith(name) else f'{name}  ←  {rel}'

        if not os.path.exists(s):
            print(f'  ✗ {label}\n      來源沒有這個檔案：{s}')
            missing.append((s, d, label))
            continue

        sh = sha256(s)
        if not os.path.exists(d):
            print(f'  ＋ {label}\n      本地沒有，來源 {sh[:16]}  {human(os.path.getsize(s))}')
            drift.append((s, d, label))
            continue

        dh = sha256(d)
        if sh == dh:
            same.append(label)
            print(f'  ✓ {label}\n      {sh[:16]}  {human(os.path.getsize(s))}')
        else:
            drift.append((s, d, label))
            print(f'  ✗ {label}')
            print(f'      來源 {sh[:16]}  {human(os.path.getsize(s))}')
            print(f'      本地 {dh[:16]}  {human(os.path.getsize(d))}')

    print()
    if missing:
        print(f'⚠ 來源缺少 {len(missing)} 個檔案——先在 Taiwanwonnerf 跑完 02_build_tiles.sh 與 05_hierarchy.py。')
        return 2

    if not drift:
        print(f'✓ 全部一致（{len(same)}／{len(FILES)}），不需要做任何事。')
        return 0

    if not args.apply:
        print(f'✗ 有 {len(drift)} 個檔案不一致。本地的副本過期了。')
        print('  確認來源是你要的版本之後，執行：')
        print('      python3 scripts/sync_tiles.py --apply')
        return 1

    os.makedirs(DEST_DIR, exist_ok=True)
    for s, d, label in drift:
        shutil.copy2(s, d)
        print(f'  → 已複製 {label}  {human(os.path.getsize(d))}')
    print(f'\n✓ 複製了 {len(drift)} 個檔案。記得 git add data/tiles/ 並提交。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
