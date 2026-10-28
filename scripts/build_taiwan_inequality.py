#!/usr/bin/env python3
"""
臺灣內部：所得分配 × 道路安全，建置 data/road_safety_inequality_tw.json

輸入（皆自動下載；離線時可用 --cache 指向先前下載的資料夾）
  · 財政部財政資訊中心〈綜稅綜合所得總額全國各縣市鄉鎮村里統計分析表〉112年度
    （data.gov.tw 103066）：各鄉鎮市區納稅單位的平均數、中位數、第一／第三分位數、標準差。
  · 內政部〈各鄉鎮市區人口密度〉112年（data.gov.tw 8410）：年底人口、土地面積。
  · 道安資訊查詢網：111–113年各縣市、各鄉鎮市區30日死亡人數（國道與「其他」無法歸屬鄉鎮，不計入）。

方法
  · 死亡率＝111–113年30日死亡人數平均 ÷ 112年底人口 × 10萬，以所得年度（112）為中心取三年平均，
    降低小鄉鎮單年數字的跳動。
  · 鄉鎮所得不均：第三分位數 ÷ 第一分位數（Q3/Q1），直接取自財政部，不需任何假設。
  · 縣市所得不均：財政部只發布鄉鎮層級的分位數，因此把各鄉鎮視為對數常態分配（以中位數與
    四分位距定參數），依納稅單位加權混合成縣市分配，再算吉尼係數、中位數與Q3/Q1。這是估計值，
    且為稅前、未含政府移轉的申報所得，不能與國際比較頁的SWIID吉尼係數直接相比。
  · 鄉鎮模型：準Poisson迴歸（死亡人數，人口×3年為offset），控制所得中位數與人口密度；
    95%區間以「縣市」為單位的叢集bootstrap取得（同縣市的鄉鎮彼此不獨立）。

只用 Python 標準函式庫。用法：python3 scripts/build_taiwan_inequality.py [--cache DIR]
"""
import argparse
import csv
import io
import json
import math
import os
import random
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from statistics import NormalDist

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_inequality import solve, spearman, bootstrap  # noqa: E402  共用統計函式

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, 'data', 'road_safety_inequality_tw.json')
UA = 'Mozilla/5.0 (compatible; schoolzone-road-safety/1.0; +https://github.com/yunching0513/schoolzone)'

INCOME_ROC = 112
DEATH_ROCS = (111, 112, 113)
FIA_URL = f'https://www.fia.gov.tw/WEB/fia/ias/ias{INCOME_ROC}/{INCOME_ROC}_165-9.csv'
POP_URL = ('https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/D1450798-F85B-4063-9761-A24B8929A684'
           '/resource/D162B6E0-77BB-4E1F-99A6-E3F44A0503BF/download')                       # 112年各鄉鎮市區人口密度
ROADSAFETY_API = 'https://roadsafety.tw/api/DashboardAjax/GetCitiesAreaAccDataStatistics'
BOOT_N, BOOT_SEED = 1000, 20261028
COUNTY_EN = {
    '臺北市': 'Taipei City', '新北市': 'New Taipei City', '桃園市': 'Taoyuan City', '臺中市': 'Taichung City',
    '臺南市': 'Tainan City', '高雄市': 'Kaohsiung City', '基隆市': 'Keelung City', '新竹市': 'Hsinchu City',
    '嘉義市': 'Chiayi City', '新竹縣': 'Hsinchu County', '苗栗縣': 'Miaoli County', '彰化縣': 'Changhua County',
    '南投縣': 'Nantou County', '雲林縣': 'Yunlin County', '嘉義縣': 'Chiayi County', '屏東縣': 'Pingtung County',
    '宜蘭縣': 'Yilan County', '花蓮縣': 'Hualien County', '臺東縣': 'Taitung County', '澎湖縣': 'Penghu County',
    '金門縣': 'Kinmen County', '連江縣': 'Lienchiang County',
}


# ------------------------------------------------------------------ 下載（含重試與快取）
def fetch(url, cache, name):
    path = os.path.join(cache, name) if cache else None
    if path and os.path.exists(path):
        return open(path, 'rb').read()
    for i in range(5):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                body = r.read()
            if path:
                os.makedirs(cache, exist_ok=True)
                open(path, 'wb').write(body)
            return body
        except Exception as e:                                  # 政府網站偶爾斷線，退避後重試
            print(f'  重試 {name}：{e}', flush=True)
            time.sleep(2 ** i)
    raise SystemExit(f'無法下載 {url}')


def read_csv(body):
    rows = csv.DictReader(io.StringIO(body.decode('utf-8-sig')))
    return [{k.replace('﻿', ''): v for k, v in r.items()} for r in rows]   # 財政部檔的 BOM 包在引號內


def deaths(cache):
    """{(縣市, 縣市+鄉鎮): 三年死亡合計}，並核對鄉鎮加總＝縣市值。"""
    out, county_tot = {}, {}
    for roc in DEATH_ROCS:
        def q(city):
            p = urllib.parse.urlencode({'City': city, 'Cyear': f'{roc}年', 'Month': '12月', 'SType': 'ALL', 'Type': '30日死亡人數'})
            return json.loads(fetch(f'{ROADSAFETY_API}?{p}', cache, f'deaths_{roc}_{city}.json'))
        tot = {r['col'][0]: r['value'] for r in q('ALL')}
        county_tot[roc] = tot
        for c in tot:
            if c in ('國道', '其他'):
                continue
            rows = q(c)
            assert sum(r['value'] for r in rows) == tot[c], f'{roc} {c} 鄉鎮加總與縣市不符'
            for r in rows:
                k = (c, c + r['col'][0])
                out[k] = out.get(k, 0) + r['value']
    return out, county_tot


# ------------------------------------------------------------------ 統計
def lognormal_mixture(towns, K=400):
    """各鄉鎮視為對數常態（中位數＋四分位距定參數），依納稅單位加權混合；回傳吉尼係數、中位數、Q3/Q1。"""
    zs = [NormalDist().inv_cdf((i + 0.5) / K) for i in range(K)]
    pts = []
    for t in towns:
        mu, s = math.log(t['median']), math.log(t['q3'] / t['q1']) / 1.3489795
        pts += [(math.exp(mu + s * z), t['units'] / K) for z in zs]
    pts.sort()
    W = sum(w for _, w in pts)
    tot = sum(x * w for x, w in pts)
    lorenz, cumx, acc, q = 0.0, 0.0, 0.0, {}
    for x, w in pts:
        nx = cumx + x * w
        lorenz += (w / W) * (cumx + nx) / 2 / tot
        cumx = nx
        acc += w
        for p in (0.25, 0.5, 0.75):
            if p not in q and acc >= W * p:
                q[p] = x
    return 1 - 2 * lorenz, q[0.5], q[0.75] / q[0.25]


def quasi_poisson(X, y, off, iters=60):
    k = len(X[0])
    b = [0.0] * k
    b[0] = math.log(sum(y) / sum(math.exp(o) for o in off))
    for _ in range(iters):
        mu = [math.exp(sum(bi * xi for bi, xi in zip(b, x)) + o) for x, o in zip(X, off)]
        z = [math.log(m) - o + (v - m) / m for m, o, v in zip(mu, off, y)]
        A = [[sum(m * x[i] * x[j] for x, m in zip(X, mu)) for j in range(k)] for i in range(k)]
        nb = solve(A, [sum(m * x[i] * zz for x, m, zz in zip(X, mu, z)) for i in range(k)])
        done = max(abs(a - c) for a, c in zip(nb, b)) < 1e-10
        b = nb
        if done:
            break
    mu = [math.exp(sum(bi * xi for bi, xi in zip(b, x)) + o) for x, o in zip(X, off)]
    A = [[sum(m * x[i] * x[j] for x, m in zip(X, mu)) for j in range(k)] for i in range(k)]
    phi = sum((v - m) ** 2 / m for v, m in zip(y, mu)) / (len(y) - k)
    se = [math.sqrt(phi * solve(A, [1.0 if i == j else 0.0 for i in range(k)])[j]) for j in range(k)]
    return b, se, phi


TERMS = {
    'iqr': lambda t: math.log(t['iqr']),        # 所得差距（Q3/Q1，對數）
    'median': lambda t: math.log(t['median']),  # 所得水準（中位數，對數）
    'density': lambda t: math.log(t['density']),
}
EFFECT = {'iqr': math.log(1.1), 'median': math.log(1.1), 'density': math.log(2)}   # +10%、+10%、倍增


def town_model(key, rows, terms, county_fe=False):
    def design(rs, cl):
        groups = sorted(set(cl))
        return [[1.0] + [TERMS[n](t) for n in terms] + ([1.0 if c == g else 0.0 for g in groups[1:]] if county_fe else [])
                for t, c in zip(rs, cl)]
    y = lambda rs: [t['deaths'] for t in rs]
    off = lambda rs: [math.log(t['population'] * len(DEATH_ROCS) / 1e5) for t in rs]
    b, se, phi = quasi_poisson(design(rows, [t['county'] for t in rows]), y(rows), off(rows))
    # 叢集 bootstrap：以縣市為單位重抽，重複抽到的縣市視為不同叢集
    counties = sorted({t['county'] for t in rows})
    by = {c: [t for t in rows if t['county'] == c] for c in counties}
    rnd, draws = random.Random(BOOT_SEED), []
    for _ in range(BOOT_N):
        rs, cl = [], []
        for j, c in enumerate(rnd.choice(counties) for _ in counties):
            rs += by[c]; cl += [j] * len(by[c])
        try:
            draws.append(quasi_poisson(design(rs, cl), y(rs), off(rs))[0])
        except (ZeroDivisionError, OverflowError):
            pass
    out = {'key': key, 'n': len(rows), 'terms': terms, 'county_fe': county_fe, 'dispersion': round(phi, 2), 'effects': {}}
    for i, n in enumerate(terms, start=1):
        vals = sorted(d[i] for d in draws)
        lo, hi = vals[int(0.025 * len(vals))], vals[int(0.975 * len(vals)) - 1]
        pct = lambda v: round((math.exp(v * EFFECT[n]) - 1) * 100, 2)
        out['effects'][n] = {'b': round(b[i], 4), 'se': round(se[i], 4), 'pct': pct(b[i]), 'pct_ci': [pct(lo), pct(hi)]}
    return out


# ------------------------------------------------------------------ 主程式
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', help='下載快取資料夾（重跑時不必重新下載）')
    args = ap.parse_args()

    print('· 財政部綜所稅鄉鎮統計 …', flush=True)
    fia = {r['縣市別']: r for r in read_csv(fetch(FIA_URL, args.cache, f'fia_{INCOME_ROC}.csv')) if r['村里'] == '合計'}
    print('· 內政部鄉鎮人口 …', flush=True)
    pop = {r['site_id']: r for r in read_csv(fetch(POP_URL, args.cache, f'pop_{INCOME_ROC}.csv'))
           if r['statistic_yyy'] == str(INCOME_ROC)}
    print('· 道安資訊查詢網 30 日死亡 …', flush=True)
    dmap, county_tot = deaths(args.cache)

    towns = []
    for (c, name), d in sorted(dmap.items()):
        f, p = fia.get(name), pop.get(name)
        if not f or not p:
            raise SystemExit(f'對不上：{name}')
        P = int(p['people_total'])
        towns.append({
            'county': c, 'name': name[len(c):], 'population': P, 'area_km2': float(p['area']),
            'density': float(p['population_density']), 'deaths': d, 'rate': round(d / len(DEATH_ROCS) / P * 1e5, 2),
            'units': int(f['納稅單位(戶)']), 'income_total': float(f['綜合所得總額']), 'mean': float(f['平均數']),
            'median': float(f['中位數']), 'q1': float(f['第一分位數']), 'q3': float(f['第三分位數']),
            'sd': float(f['標準差']),
        })
    for t in towns:
        t['iqr'] = round(t['q3'] / t['q1'], 3)
    print(f'  {len(towns)} 個鄉鎮市區')

    counties = []
    for c in COUNTY_EN:
        ts = [t for t in towns if t['county'] == c]
        P, U = sum(t['population'] for t in ts), sum(t['units'] for t in ts)
        mean = sum(t['income_total'] for t in ts) / U
        var = sum(t['units'] * (t['sd'] ** 2 + (t['mean'] - mean) ** 2) for t in ts) / U   # 組內＋組間變異
        gini, med, iqr = lognormal_mixture(ts)
        d = sum(t['deaths'] for t in ts)
        counties.append({
            'county': c, 'en': COUNTY_EN[c], 'population': P, 'deaths': d,
            'rate': round(d / len(DEATH_ROCS) / P * 1e5, 2), 'density': round(P / sum(t['area_km2'] for t in ts), 1),
            'units': U, 'mean': round(mean, 1), 'cv': round(math.sqrt(var) / mean, 3),
            'gini_est': round(gini, 3), 'median_est': round(med, 1), 'iqr_est': round(iqr, 3), 'n_towns': len(ts),
        })

    def corr(rows, xk, yk='rate'):
        x, y = [r[xk] for r in rows], [r[yk] for r in rows]
        return {'n': len(rows), 'spearman': round(spearman(x, y), 3),
                'ci': [round(v, 3) for v in bootstrap(rows, lambda s: spearman([r[xk] for r in s], [r[yk] for r in s]))]}

    print('· 鄉鎮模型（叢集 bootstrap）…', flush=True)
    models = [
        town_model('T1', towns, ['iqr']),
        town_model('T2', towns, ['median', 'density']),
        town_model('T3', towns, ['median', 'density', 'iqr']),
        town_model('T4', towns, ['median', 'density', 'iqr'], county_fe=True),
    ]
    # 對數常態近似的檢核：由中位數與四分位距推得的平均數 ÷ 財政部實際平均數
    chk = sorted(math.exp(math.log(t['median']) + (math.log(t['q3'] / t['q1']) / 1.3489795) ** 2 / 2) / t['mean'] for t in towns)
    out = {
        'meta': {
            'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
            'income_year': INCOME_ROC + 1911, 'death_years': [r + 1911 for r in DEATH_ROCS],
            'deaths_total': {str(r + 1911): sum(v for k, v in county_tot[r].items()) for r in DEATH_ROCS},
            'deaths_unassigned': {str(r + 1911): county_tot[r].get('國道', 0) + county_tot[r].get('其他', 0) for r in DEATH_ROCS},
            'n_towns': len(towns), 'zero_death_towns': sum(t['deaths'] == 0 for t in towns),
            'bootstrap': {'n': BOOT_N, 'seed': BOOT_SEED, 'cluster': 'county'},
            'lognormal_check': {'p10': round(chk[len(chk) // 10], 3), 'p50': round(chk[len(chk) // 2], 3),
                                'p90': round(chk[9 * len(chk) // 10], 3)},
            'county_corr': {k: corr(counties, k) for k in ('gini_est', 'iqr_est', 'cv', 'median_est', 'density')},
            'town_corr': {k: corr(towns, k) for k in ('iqr', 'median', 'density')},
            'models': {m['key']: m for m in models},
            'sources': {
                'income': f'財政部財政資訊中心，{INCOME_ROC}年度綜稅綜合所得總額全國各縣市鄉鎮村里統計分析表（data.gov.tw 103066）',
                'population': f'內政部，{INCOME_ROC}年各鄉鎮市區人口密度（data.gov.tw 8410）',
                'deaths': '交通部道安資訊查詢網，30日死亡人數（roadsafety.tw）',
            },
            'urls': {'income': FIA_URL, 'population': POP_URL, 'deaths': 'https://roadsafety.tw/'},
        },
        'counties': counties,
        'towns': towns,
    }
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    cc = out['meta']['county_corr']
    print(f"  縣市 Spearman：吉尼（估）{cc['gini_est']['spearman']:+.2f}、中位數 {cc['median_est']['spearman']:+.2f}、密度 {cc['density']['spearman']:+.2f}")
    e = models[2]['effects']['iqr']; e4 = models[3]['effects']['iqr']
    print(f"  T3 Q3/Q1 +10% → 死亡 {e['pct']:+.1f}%（{e['pct_ci'][0]:+.1f}～{e['pct_ci'][1]:+.1f}）；T4 {e4['pct']:+.1f}%（{e4['pct_ci'][0]:+.1f}～{e4['pct_ci'][1]:+.1f}）")
    print(f'→ {os.path.relpath(OUT_PATH, ROOT)}')


if __name__ == '__main__':
    sys.exit(main())
