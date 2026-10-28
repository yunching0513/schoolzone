#!/usr/bin/env python3
"""
所得分配不均 × 道路安全：建置 data/road_safety_inequality.json

輸入
  · data/road_safety_gdp.json（由 scripts/build_road_safety.py 產生：WHO 死亡率、IMF 人均 GDP、大洲分組）
  · SWIID 標準化世界所得不平等資料庫（Solt）摘要檔 swiid*_summary.csv
    預設自 Harvard Dataverse 下載 v9.92；離線時可用 --swiid 指定已解壓的 csv。

方法
  · 吉尼係數用 gini_disp（可支配所得、稅與移轉後），每國取 2018–2023 年間最新一年。
  · 迴歸皆為 OLS，依變數 ln(死亡率)：
        M0  ln(人均 GDP)
        M1  ln(人均 GDP) + 吉尼係數
        M2  ln(人均 GDP) + 吉尼係數 + 大洲（亞洲・大洋洲為基準）
        H1  同 M1，只用高所得國家
    吉尼係數的效果換算成「每增加 1 點，死亡率增減幾 %」= (e^b − 1) × 100。
    95% 區間以 bootstrap（2,000 次、固定種子）取百分位；相關係數同法。
  · 「所得預期死亡率」= M0 的預測值；實際 ÷ 預期 > 1 代表比同所得水準的國家更致命。

只用 Python 標準函式庫，與 build_road_safety.py 一致。
用法：python3 scripts/build_inequality.py [--swiid path/to/swiid9_92_summary.csv]
"""
import argparse
import csv
import io
import json
import math
import os
import random
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IN_PATH = os.path.join(ROOT, 'data', 'road_safety_gdp.json')
OUT_PATH = os.path.join(ROOT, 'data', 'road_safety_inequality.json')

SWIID_VERSION = '9.92'
SWIID_FILE_ID = 13657070                                   # swiid9_92.zip（Dataverse doi:10.7910/DVN/LM4OWF）
SWIID_URL = f'https://dataverse.harvard.edu/api/access/datafile/{SWIID_FILE_ID}'
SWIID_DOI = 'https://doi.org/10.7910/DVN/LM4OWF'
UA = 'Mozilla/5.0 (compatible; schoolzone-road-safety/1.0; +https://github.com/yunching0513/schoolzone)'

YEAR_MIN, YEAR_MAX = 2018, 2023
BOOT_N, BOOT_SEED = 2000, 20261028
GROUPS = ['asia', 'europe', 'americas', 'africa']          # 第一個為迴歸基準組

# SWIID 國名 → 本專案國名（build_road_safety.py 的 en 欄位）
ALIAS = {
    'Antigua and Barbuda': 'Antigua & Barbuda', 'Bosnia and Herzegovina': 'Bosnia & Herzegovina',
    "Côte d'Ivoire": 'Côte d’Ivoire', 'Congo-Kinshasa': 'Congo - Kinshasa', 'Congo-Brazzaville': 'Congo - Brazzaville',
    'Czech Republic': 'Czechia', 'Korea': 'South Korea', 'Myanmar': 'Myanmar (Burma)',
    'São Tomé and Príncipe': 'São Tomé & Príncipe', 'Trinidad and Tobago': 'Trinidad & Tobago', 'Turkey': 'Türkiye',
    'St. Vincent and Grenadines': 'St. Vincent & Grenadines',
}


# ------------------------------------------------------------------ 資料
def load_swiid(path):
    if path:
        text = open(path, encoding='utf-8').read()
    else:
        print(f'· 下載 SWIID {SWIID_VERSION} …', flush=True)
        req = urllib.request.Request(SWIID_URL, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=300) as r:
            z = zipfile.ZipFile(io.BytesIO(r.read()))
        name = next(n for n in z.namelist() if n.endswith('_summary.csv'))
        text = z.read(name).decode('utf-8')
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        out.setdefault(ALIAS.get(row['country'], row['country']), {})[int(row['year'])] = row
    return out


def num(v):
    return float(v) if v not in ('', None, 'NA') else None


# ------------------------------------------------------------------ 統計（標準函式庫）
def solve(A, b):
    n = len(A)
    M = [row[:] + [bb] for row, bb in zip(A, b)]
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(M[r][i]))
        M[i], M[p] = M[p], M[i]
        for r in range(n):
            if r != i:
                f = M[r][i] / M[i][i]
                M[r] = [a - f * c for a, c in zip(M[r], M[i])]
    return [M[i][n] / M[i][i] for i in range(n)]


def ols(X, y):
    k = len(X[0])
    XtX = [[sum(r[i] * r[j] for r in X) for j in range(k)] for i in range(k)]
    Xty = [sum(r[i] * v for r, v in zip(X, y)) for i in range(k)]
    b = solve(XtX, Xty)
    fit = [sum(bi * xi for bi, xi in zip(b, r)) for r in X]
    res = [v - f for v, f in zip(y, fit)]
    n = len(y)
    s2 = sum(e * e for e in res) / (n - k)
    inv_diag = [solve(XtX, [1.0 if i == j else 0.0 for i in range(k)])[j] for j in range(k)]
    se = [math.sqrt(s2 * d) for d in inv_diag]
    my = sum(y) / n
    r2 = 1 - sum(e * e for e in res) / sum((v - my) ** 2 for v in y)
    return {'b': b, 'se': se, 'r2': r2, 'fit': fit}


def pearson(x, y):
    n = len(x); mx = sum(x) / n; my = sum(y) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(x, y))
    return sxy / math.sqrt(sum((a - mx) ** 2 for a in x) * sum((b - my) ** 2 for b in y))


def ranks(v):
    order = sorted(range(len(v)), key=lambda i: v[i])
    r = [0.0] * len(v); i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
            j += 1
        for k in range(i, j + 1):
            r[order[k]] = (i + j) / 2
        i = j + 1
    return r


def spearman(x, y):
    return pearson(ranks(x), ranks(y))


def bootstrap(rows, stat):
    rnd = random.Random(BOOT_SEED)
    vals = []
    for _ in range(BOOT_N):
        s = [rnd.choice(rows) for _ in rows]
        try:
            vals.append(stat(s))
        except ZeroDivisionError:                              # 抽到退化樣本（極少見）就略過
            pass
    vals.sort()
    return [vals[int(0.025 * len(vals))], vals[int(0.975 * len(vals)) - 1]]


pct = lambda b: (math.exp(b) - 1) * 100                         # 對數係數 → 每 1 點的 % 變化


def design(rows, gini=True, region=False):
    X = []
    for r in rows:
        x = [1.0, math.log(r['gdp_pc'])]
        if gini:
            x.append(r['gini'])
        if region:
            x += [1.0 if r['group'] == g else 0.0 for g in GROUPS[1:]]
        X.append(x)
    return X


def fit_model(key, rows, gini=True, region=False):
    y = [math.log(r['rate']) for r in rows]
    m = ols(design(rows, gini, region), y)
    out = {'key': key, 'n': len(rows), 'r2': round(m['r2'], 3),
           'b_lngdp': round(m['b'][1], 4)}
    if gini:
        b, se = m['b'][2], m['se'][2]
        lo, hi = bootstrap(rows, lambda s: ols(design(s, gini, region), [math.log(r['rate']) for r in s])['b'][2])
        out.update({'b_gini': round(b, 4), 'se_gini': round(se, 4), 't_gini': round(b / se, 2),
                    'gini_pct': round(pct(b), 2), 'gini_pct_ci': [round(pct(lo), 2), round(pct(hi), 2)]})
    return out, m


# ------------------------------------------------------------------ 主程式
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--swiid', help='已解壓的 swiid*_summary.csv（省略則自 Dataverse 下載）')
    args = ap.parse_args()

    base = json.load(open(IN_PATH, encoding='utf-8'))
    swiid = load_swiid(args.swiid)
    thr = base['meta']['gdp_threshold']

    rows, unmatched = [], []
    for c in base['countries']:
        if not c.get('rate') or not c.get('gdp_pc'):
            continue
        s = swiid.get(c['en'])
        years = [y for y in (s or {}) if YEAR_MIN <= y <= YEAR_MAX and num(s[y]['gini_disp']) is not None]
        if not years:
            unmatched.append(c['iso3'])
            continue
        y = max(years); g = s[y]
        rows.append({
            'iso3': c['iso3'], 'zh': c['zh'], 'en': c['en'], 'group': c['group'], 'focus': c.get('focus', False),
            'rate': c['rate'], 'rate_source': c.get('rate_source'), 'gdp_pc': c['gdp_pc'], 'hic': c['gdp_pc'] >= thr,
            'gini': num(g['gini_disp']), 'gini_se': num(g['gini_disp_se']), 'gini_year': y,
            'gini_mkt': num(g['gini_mkt']), 'redistribution': num(g['rel_red']),
        })
    print(f'  配對 {len(rows)} 國；缺吉尼係數 {len(unmatched)} 國')

    hic = [r for r in rows if r['hic']]
    m0, f0 = fit_model('M0', rows, gini=False)
    m1, f1 = fit_model('M1', rows)
    m2, _ = fit_model('M2', rows, region=True)
    h1, fh = fit_model('H1', hic)
    for r, e0, e1 in zip(rows, f0['fit'], f1['fit']):
        r['expected'] = round(math.exp(e0), 2)                  # 所得預期（M0）
        r['ratio'] = round(r['rate'] / math.exp(e0), 3)
        r['expected_m1'] = round(math.exp(e1), 2)               # 所得＋吉尼預期（M1）

    def corr(rs, xk, yk):
        x = [r[xk] for r in rs]; y = [r[yk] for r in rs]
        return {'n': len(rs), 'spearman': round(spearman(x, y), 3), 'pearson': round(pearson(x, y), 3),
                'spearman_ci': [round(v, 3) for v in bootstrap(rs, lambda s: spearman([r[xk] for r in s], [r[yk] for r in s]))]}

    red = [r for r in hic if r['redistribution'] is not None]
    red_m, _ = (lambda rs: (ols([[1.0, math.log(r['gdp_pc']), r['redistribution']] for r in rs],
                                [math.log(r['rate']) for r in rs]), None))(red)
    tw = next(r for r in rows if r['iso3'] == 'TWN')
    by_ratio = sorted(hic, key=lambda r: -r['ratio'])

    out = {
        'meta': {
            'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
            'year': base['meta']['year'], 'gdp_threshold': thr,
            'gini_years': [YEAR_MIN, YEAR_MAX], 'swiid_version': SWIID_VERSION, 'swiid_doi': SWIID_DOI,
            'bootstrap': {'n': BOOT_N, 'seed': BOOT_SEED},
            'unmatched': unmatched,
            'corr_all': corr(rows, 'gini', 'rate'),
            'corr_hic': corr(hic, 'gini', 'rate'),
            'corr_ratio': corr(rows, 'gini', 'ratio'),
            'models': {'M0': m0, 'M1': m1, 'M2': m2, 'H1': h1},
            'redistribution_hic': {'n': len(red), 'spearman': round(spearman([r['redistribution'] for r in red], [r['rate'] for r in red]), 3),
                                   'b_controlled': round(red_m['b'][2], 4), 't_controlled': round(red_m['b'][2] / red_m['se'][2], 2)},
            'taiwan': {'gini': tw['gini'], 'gini_year': tw['gini_year'], 'rate': tw['rate'],
                       'expected': tw['expected'], 'ratio': tw['ratio'], 'expected_m1': tw['expected_m1'],
                       'ratio_rank_hic': by_ratio.index(tw) + 1, 'n_hic': len(hic),
                       'gini_rank_low_hic': sorted(hic, key=lambda r: r['gini']).index(tw) + 1,
                       'above_in_hic': [r['iso3'] for r in by_ratio[:by_ratio.index(tw)]]},
            'sources': {
                'swiid': f'Solt, Frederick. The Standardized World Income Inequality Database (SWIID), v{SWIID_VERSION}. Harvard Dataverse, {SWIID_DOI}',
                'base': 'data/road_safety_gdp.json（WHO GHO RS_198、IMF WEO、World Bank；臺灣為交通部 30 日死亡）',
            },
        },
        'countries': sorted(rows, key=lambda r: r['iso3']),
    }
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    t = out['meta']['taiwan']
    print(f"  M1 吉尼 +1 點 → 死亡率 {m1['gini_pct']:+.1f}%（{m1['gini_pct_ci'][0]:+.1f}～{m1['gini_pct_ci'][1]:+.1f}）；"
          f"加大洲 M2 {m2['gini_pct']:+.1f}%（{m2['gini_pct_ci'][0]:+.1f}～{m2['gini_pct_ci'][1]:+.1f}）")
    print(f"  臺灣 吉尼 {t['gini']}（{t['gini_year']}）實際 {t['rate']} ／ 所得預期 {t['expected']} = {t['ratio']:.2f} 倍，"
          f"高所得國第 {t['ratio_rank_hic']}／{t['n_hic']}")
    print(f'→ {os.path.relpath(OUT_PATH, ROOT)}')


if __name__ == '__main__':
    sys.exit(main())
