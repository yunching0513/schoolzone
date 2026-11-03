#!/usr/bin/env python3
"""
以臺北市官方道路測繪檢核「生活街道」（Taiwanwonnerf）的 OSM 路寬推估，建置 data/living_streets_taipei_check.json

輸入
  · data/tiles/living_streets.pmtiles：Taiwanwonnerf 的 OSM 路段與估算路寬（w）、分級（cls）、推估依據（src）。
    這份圖磚只收15公尺以下的路段；推估超過15公尺的路段，從 data/tiles/hierarchy.pmtiles（幹道層級）補回，
    凡是不在前者、出現在後者的 way，即為 OSM 推估 >15 公尺。
  · 臺北市工務局〈臺北市寬度超過8公尺道路GIS圖資〉：與 build_parking_space.py 共用下載快取（road8m.zip）。
  · 臺北市行政區界：Taiwan Mobility Atlas 的 districts.geojson（g0v 行政區界簡化版），只用來篩出臺北市的路段。

方法
  · 讀取 z13 圖磚（最高層級，沒有被刪減的路段），同一條 OSM way 跨圖磚時只取一次，以該段的中點代表位置。
  · 中點落在（或距離 --tol 公尺內，預設3公尺，容許 OSM 線形的偏移）某段8公尺以上道路 → 官方路寬＝該段 ROADWIDTH；都不在 → 視為8公尺以下的道路。
    路口路段（ROADWIDTH 為0）不列入比較。
  · 只比較公共道路類型（primary、secondary、tertiary、unclassified、residential、living_street、road 及其連絡道）；
    service（車道、停車場通道、校園內部道路）與 pedestrian 不在官方道路圖資內，另列。
    幹道的單行路段（oneway＝yes 的 primary／secondary／tertiary）多半是分隔道路的單一方向，
    OSM 路寬只代表半邊、官方路寬是整條路，無法直接比較，也另列。
  · 指標以路段長度加權：分級一致率、「≤12公尺」判定的精確率與召回率，以及8公尺以上道路的路寬誤差。

需要 pmtiles、mapbox-vector-tile、shapely、pyshp、pyproj。
用法：python3 scripts/validate_living_streets_taipei.py --cache DIR
"""
import argparse
import collections
import gzip
import json
import math
import os
import statistics
import sys
from datetime import datetime, timezone

import mapbox_vector_tile as mvt
from pmtiles.reader import MmapSource, Reader
from pyproj import Transformer
from shapely import STRtree, points
from shapely.geometry import LineString, shape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_parking_space import fetch, shp_from_zip  # noqa: E402  共用下載快取與 SHP 讀取

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PMTILES = os.path.join(ROOT, 'data', 'tiles', 'living_streets.pmtiles')
HIER = os.path.join(ROOT, 'data', 'tiles', 'hierarchy.pmtiles')
OUT_PATH = os.path.join(ROOT, 'data', 'living_streets_taipei_check.json')
DISTRICTS_URL = 'https://yunching0513.github.io/taiwan-mobility-atlas/districts.geojson'
Z = 13
PUBLIC = {'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
          'unclassified', 'residential', 'living_street', 'road'}
CLASS_ORDER = ('le8', 'w8_12', 'w12_15', 'gt15')
DIVIDED_HW = {'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link'}


def width_class(w):
    return 'le8' if w <= 8 else 'w8_12' if w <= 12 else 'w12_15' if w <= 15 else 'gt15'


def taipei_boundary(cache):
    import urllib.request
    path = os.path.join(cache, 'districts.geojson') if cache else None
    if path and os.path.exists(path):
        gj = json.load(open(path, encoding='utf-8'))
    else:
        gj = json.loads(urllib.request.urlopen(DISTRICTS_URL, timeout=60).read().decode('utf-8'))
        if path:
            json.dump(gj, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
    from shapely.ops import unary_union
    polys = [shape(f['geometry']) for f in gj['features'] if f['properties'].get('COUNTYNAME') in ('台北市', '臺北市')]
    return unary_union(polys)


def osm_ways(boundary, path=PMTILES, layer_name='living_streets', seen=None):
    """回傳臺北市範圍內每條 OSM way 的中點（經緯度）與屬性；seen 中已有的 way 略過。"""
    src = open(path, 'rb')
    r = Reader(MmapSource(src))
    minx, miny, maxx, maxy = boundary.bounds
    n = 2 ** Z
    tx = lambda lon: int((lon + 180) / 360 * n)
    ty = lambda lat: int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    seen, out = (set() if seen is None else seen), []
    for x in range(tx(minx), tx(maxx) + 1):
        for y in range(ty(maxy), ty(miny) + 1):
            raw = r.get(Z, x, y)
            if not raw:
                continue
            if raw[:2] == b'\x1f\x8b':
                raw = gzip.decompress(raw)
            layer = mvt.decode(raw).get(layer_name)
            if not layer:
                continue
            ext = layer['extent']
            for f in layer['features']:
                p = f['properties']
                if p['id'] in seen or f['geometry']['type'] != 'LineString':
                    continue
                coords = f['geometry']['coordinates']           # 圖磚座標，原點在左下（mapbox_vector_tile 預設 y 向上）
                mid = LineString(coords).interpolate(0.5, normalized=True)
                lon = (x + mid.x / ext) / n * 360 - 180
                lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1 - mid.y / ext) / n))))
                seen.add(p['id'])
                out.append((lon, lat, p))
    src.close()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', required=True, help='與 build_parking_space.py 共用的下載快取（需含 road8m.zip）')
    ap.add_argument('--tol', type=float, default=3.0, help='中點與8公尺以上道路的容許距離（公尺）')
    args = ap.parse_args()

    boundary = taipei_boundary(args.cache)
    seen = set()
    ways = osm_ways(boundary, seen=seen)
    wide = osm_ways(boundary, HIER, 'hierarchy', seen=seen)          # 推估 >15 公尺：只在幹道圖磚出現的 way
    for _, _, p in wide:
        p['w'], p['src'], p['cls'] = 99, 'wide', 'X'
    ways += wide
    ways = [w for w in ways if boundary.contains(points(w[0], w[1]))]
    print(f'臺北市 OSM 路段 {len(ways):,} 條', file=sys.stderr)

    rr, _ = shp_from_zip(fetch('road8m', args.cache), 'Road')
    polys, widths = [], []
    for sr in rr.iterShapeRecords():
        polys.append(shape(sr.shape.__geo_interface__)); widths.append(sr.record.as_dict()['ROADWIDTH'] or 0)
    tree = STRtree(polys)
    to_tm = Transformer.from_crs('EPSG:4326', 'EPSG:3826', always_xy=True)
    xs, ys = to_tm.transform([w[0] for w in ways], [w[1] for w in ways])
    pi, ri = tree.query(points(list(zip(xs, ys))), predicate='dwithin', distance=args.tol)
    official = {}
    for i, j in zip(pi.tolist(), ri.tolist()):
        official[i] = max(official.get(i, 0), widths[j])

    km = lambda m: round(m / 1000, 1)
    conf = collections.defaultdict(float)                  # (OSM分級, 官方分級) → 公尺
    by_hw = collections.defaultdict(lambda: collections.Counter())
    err = collections.defaultdict(list)                    # 推估依據 → [(OSM − 官方, 長度)]
    total = collections.Counter()
    suffix = collections.defaultdict(lambda: collections.Counter())   # 路名後綴 → 官方分級的長度
    for i, (_, _, p) in enumerate(ways):
        L = float(p.get('len') or 0)
        hw = p.get('hw', '')
        total['all'] += L
        if hw not in PUBLIC:
            by_hw['excluded'][hw] += L
            continue
        if hw in DIVIDED_HW and p.get('ow') in ('yes', '-1'):
            total['divided'] += L
            continue
        ow = official.get(i)
        if ow == 0:                                        # 路口，官方未標路寬
            total['junction'] += L
            continue
        oc = 'le8' if ow is None else width_class(ow)
        conf[(width_class(float(p['w'])), oc)] += L
        name = (p.get('name') or '').strip()
        sfx = next((k for k in ('弄', '巷', '街', '路', '大道') if name.endswith(k) or (k in ('路', '街') and name[-2:-1] == k and name[-1] == '段')), None)
        if not sfx and name[-1:] == '段':
            sfx = '路' if '路' in name else '街' if '街' in name else None
        suffix[sfx or '（無名或其他）'][oc] += L
        total['compared'] += L
        if ow and p['src'] != 'wide':
            err[p['src']].append((float(p['w']) - ow, L))

    cm = sum(conf.values())
    agree = sum(v for (a, b), v in conf.items() if a == b) / cm
    le12 = lambda c: c in ('le8', 'w8_12')
    tp = sum(v for (a, b), v in conf.items() if le12(a) and le12(b))
    fp = sum(v for (a, b), v in conf.items() if le12(a) and not le12(b))
    fn = sum(v for (a, b), v in conf.items() if not le12(a) and le12(b))

    def wmedian(pairs):
        pairs = sorted(pairs)
        half, acc = sum(L for _, L in pairs) / 2, 0
        for v, L in pairs:
            acc += L
            if acc >= half:
                return v
        return None
    errors = {}
    for s, pairs in err.items():
        errors[s] = {'km': km(sum(L for _, L in pairs)), 'median_error_m': round(wmedian(pairs), 1),
                     'median_abs_error_m': round(wmedian([(abs(v), L) for v, L in pairs]), 1),
                     'underestimate_share': round(sum(L for v, L in pairs if v < 0) / sum(L for _, L in pairs), 3)}
    allp = [x for v in err.values() for x in v]
    out = {
        'meta': {
            'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'zoom': Z, 'ways': len(ways), 'km_all': km(total['all']), 'km_compared': km(total['compared']),
            'km_junction': km(total['junction']), 'km_divided_oneway': km(total['divided']), 'tolerance_m': args.tol, 'km_excluded': {k: km(v) for k, v in by_hw['excluded'].most_common()},
            'classes': CLASS_ORDER,
            'sources': {'osm': 'https://github.com/yunching0513/202609---Taiwanwonnerf',
                        'road8m': 'https://data.taipei/dataset/detail?id=ee2e4015-8844-48fb-aa57-31209909b0fc',
                        'districts': DISTRICTS_URL},
        },
        'confusion_km': {f'{a}|{b}': km(v) for (a, b), v in sorted(conf.items())},
        'agreement': round(agree, 3),
        'by_suffix_km': {k: {c: km(v[c]) for c in CLASS_ORDER} for k, v in suffix.items()},
        'le12': {'precision': round(tp / (tp + fp), 3), 'recall': round(tp / (tp + fn), 3)},
        'width_error_8m_plus': {'all': {'km': km(sum(L for _, L in allp)),
                                        'median_error_m': round(wmedian(allp), 1),
                                        'median_abs_error_m': round(wmedian([(abs(v), L) for v, L in allp]), 1)},
                                'by_src': errors},
    }
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"寫入 {OUT_PATH}：分級一致 {agree:.1%}；≤12m 精確率 {out['le12']['precision']:.1%}、召回率 {out['le12']['recall']:.1%}",
          file=sys.stderr)


if __name__ == '__main__':
    main()
