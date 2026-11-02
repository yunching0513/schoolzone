#!/usr/bin/env python3
"""
臺北市街道空間：路邊汽機車停車格佔了多少？建置 data/taipei_parking_space.json

輸入（皆自動下載；離線時可用 --cache 指向先前下載的資料夾）
  · 臺北市停車管理工程處〈臺北市路邊停車格位〉SHP（data.taipei 00000284，每月更新）：
    每一個路邊停車格的多邊形，含格位種類（pktype）與行政區。
  · 臺北市工務局新建工程處〈臺北市寬度超過8公尺道路GIS圖資〉SHP（103–105年測繪）：
    每一段道路的面積，以及其中人行道、側溝、中央分隔島、快慢分隔島的面積。
  · 臺北市工務局〈臺北市都市計畫區域內現有已開闢道路長度及面積〉：各行政區全部已開闢道路面積。
  · 臺北市交通局〈臺北市公有收費停車位統計表〉：路邊與路外收費格位數（用來核對）。
  · 臺北市停車管理工程處〈停車場資訊〉（TCMSV_alldesc.json）：路外停車場的汽機車格位數。
  · 內政部〈各鄉鎮市區人口密度〉112年：各行政區土地面積與人口。
  · 臺北市主計處〈臺北市機動車輛登記數按月別、按行政區別〉：各區汽車（含自用、營業用）與機車登記數。

方法
  · 停車格面積＝格位多邊形的面積（TWD97 TM2，公尺），不是用標準尺寸換算。
  · 格位種類依停管處欄位說明歸類：汽車（小型車、身障汽車、警車、大型車、貨車裝卸、計程車、限時、
    時段性禁停汽車、公用汽車、停車彎、消防車、垃圾車、大客車共用）、機車（機車、身障機車、公用機車、
    警用機車、時段禁停機車、限時機車、汽機車彈性共用）、機慢車停放區（含自行車，只計面積）。
    欄位說明未列的代碼（50、60、70、71等）另列「代碼未說明」，不計入汽機車。
  · 以格位多邊形的中心點判斷是否落在8公尺以上道路的範圍內，用來拆解這些道路的空間組成：
    人行道、分隔島與側溝、路邊停車格、其餘車道。
  · 路外停車場多在地下室或建築內，資料只有格位數、沒有面積，因此只列格位數，不換算面積。
  · 車輛的停放面積：以路邊格的實測平均面積（汽車約10.7 m²、機車約1.5 m²）乘以登記數。這只是畫線格位
    本身的大小，不含車道與進出空間，是保守的下限。

需要 pyshp 與 shapely（pip install pyshp shapely）。用法：python3 scripts/build_parking_space.py [--cache DIR]
"""
import argparse
import collections
import csv
import io
import json
import os
import sys
import time
import urllib.request
import zipfile
from datetime import datetime, timezone

try:
    import shapefile                       # pyshp
    from shapely import STRtree, points
    from shapely.geometry import shape
except ImportError:
    sys.exit('需要 pyshp 與 shapely：pip install pyshp shapely')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, 'data', 'taipei_parking_space.json')
UA = 'Mozilla/5.0 (compatible; schoolzone-parking/1.0; +https://github.com/yunching0513/schoolzone)'

DT = 'https://data.taipei/api/dataset/{}/resource/{}/download'
SRC = {
    'slots': (DT.format('5a911ea5-1694-4301-808e-e1780d971611', '7e2f32a0-9201-4666-a0ed-11034e6c2b66'), 'slots.zip'),
    'road8m': (DT.format('ee2e4015-8844-48fb-aa57-31209909b0fc', '074a401d-45a2-4748-bf62-7d5372d53d45'), 'road8m.zip'),
    'roadplan': (DT.format('caeceb7e-5991-488c-becd-382ffc3015f5', '1e2a8450-181d-4040-8297-3737e72cac48'), 'roadplan.csv'),
    'pubspace': (DT.format('435deea7-eee3-4429-bb36-9a105cda0967', '45f04fa0-35e2-4b8e-9335-b5da0bee033a'), 'pubspace.csv'),
    'lots': ('https://tcgbusfs.blob.core.windows.net/blobtcmsv/TCMSV_alldesc.json', 'lots.json'),
    'vehicles': ('https://tsis.dbas.gov.taipei/statis/webMain.aspx?sys=220&ymf=10801&kind=21&type=0&funid=a04002202'
                 '&cycle=1&outmode=12&compmode=0&outkind=3&deflst=2&nzo=1', 'vehicles.csv'),
    'pop': ('https://opdadm.moi.gov.tw/api/v1/no-auth/resource/api/dataset/D1450798-F85B-4063-9761-A24B8929A684'
            '/resource/D162B6E0-77BB-4E1F-99A6-E3F44A0503BF/download', 'pop112.csv'),
}
PAGES = {
    'slots': 'https://data.taipei/dataset/detail?id=5a911ea5-1694-4301-808e-e1780d971611',
    'road8m': 'https://data.taipei/dataset/detail?id=ee2e4015-8844-48fb-aa57-31209909b0fc',
    'roadplan': 'https://data.taipei/dataset/detail?id=caeceb7e-5991-488c-becd-382ffc3015f5',
    'pubspace': 'https://data.taipei/dataset/detail?id=435deea7-eee3-4429-bb36-9a105cda0967',
    'lots': 'https://data.taipei/dataset/detail?id=d5c0656b-5250-4179-a491-c94daa56ef2c',
    'vehicles': 'https://data.taipei/dataset/detail?id=bf7f4c40-ac1c-41ee-860d-9c8387aa88c0',
}
DISTRICTS = ['中正區', '大同區', '中山區', '松山區', '大安區', '萬華區', '信義區', '士林區', '北投區', '內湖區', '南港區', '文山區']
DISTRICT_EN = {
    '中正區': 'Zhongzheng', '大同區': 'Datong', '中山區': 'Zhongshan', '松山區': 'Songshan', '大安區': "Da'an",
    '萬華區': 'Wanhua', '信義區': 'Xinyi', '士林區': 'Shilin', '北投區': 'Beitou', '內湖區': 'Neihu',
    '南港區': 'Nangang', '文山區': 'Wenshan',
}
CAR = {'01', '03', '05', '06', '07', '08', '09', '10', '12', '121', '15', '17', '21', '23'}
MOTO = {'02', '04', '13', '131', '14', '19', '20', '22'}
ZONE = {'11', '16', '18'}                                   # 機慢車停放區：含自行車，只計面積
CLASSES = ('car', 'moto', 'zone', 'other')


def klass(code):
    return 'car' if code in CAR else 'moto' if code in MOTO else 'zone' if code in ZONE else 'other'


def fetch(key, cache):
    url, name = SRC[key]
    path = os.path.join(cache, name) if cache else None
    if path and os.path.exists(path):
        return open(path, 'rb').read()
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            body = urllib.request.urlopen(req, timeout=300).read()
            break
        except Exception as e:                              # 偶發的連線中斷：退避後重試
            if attempt == 3:
                raise
            print(f'  {name} 下載失敗（{e}），{2 ** (attempt + 1)}秒後重試', file=sys.stderr)
            time.sleep(2 ** (attempt + 1))
    if path:
        os.makedirs(cache, exist_ok=True)
        open(path, 'wb').write(body)
    return body


def read_csv(raw, enc='utf-8-sig'):
    return list(csv.DictReader(io.StringIO(raw.decode(enc))))


def shp_from_zip(raw, stem_hint):
    """從zip讀出 .shp／.shx／.dbf，回傳 pyshp Reader 與檔名主幹。"""
    z = zipfile.ZipFile(io.BytesIO(raw))
    shp = next(n for n in z.namelist() if n.lower().endswith('.shp') and stem_hint in n)
    stem = shp[:-4]
    part = lambda ext: io.BytesIO(z.read(stem + ext))
    return shapefile.Reader(shp=part('.shp'), shx=part('.shx'), dbf=part('.dbf'), encoding='utf-8'), stem.split('/')[-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', help='下載快取資料夾')
    args = ap.parse_args()

    # 8公尺以上道路：面積組成
    print('讀取8公尺以上道路…', file=sys.stderr)
    rr, _ = shp_from_zip(fetch('road8m', args.cache), 'Road')
    roads, road_dist = [], []
    comp = collections.defaultdict(collections.Counter)
    for sr in rr.iterShapeRecords():
        d = sr.record.as_dict()
        dist = d['TOWNNAME']
        if dist not in DISTRICT_EN:
            continue
        g = shape(sr.shape.__geo_interface__)
        roads.append(g); road_dist.append(dist)
        c = comp[dist]
        c['area'] += g.area
        c['sidewalk'] += d['SWALK_AREA']
        c['median'] += d['CEN_MEDIAN'] + d['CAR_MEDIAN']
        c['ditch'] += d['DITCH_AREA']
    tree = STRtree(roads)

    # 路邊停車格
    print('讀取路邊停車格（約30萬筆）…', file=sys.stderr)
    sr_, slot_stem = shp_from_zip(fetch('slots', args.cache), 'park01')
    agg = collections.defaultdict(lambda: {k: collections.Counter() for k in ('n', 'area', 'area_in8m')})
    other_codes = collections.Counter()
    cents, metas = [], []
    for s in sr_.iterShapeRecords(fields=['pktype', 'area_name']):
        rec = s.record.as_dict()
        dist = rec['area_name'].strip()
        if dist not in DISTRICT_EN:
            continue
        g = shape(s.shape.__geo_interface__)
        k = klass(rec['pktype'].strip())
        if k == 'other':
            other_codes[rec['pktype'].strip() or '（空白）'] += 1
        agg[dist]['n'][k] += 1
        agg[dist]['area'][k] += g.area
        cents.append(g.centroid); metas.append((dist, k, g.area))
    inside = set(tree.query(points([(c.x, c.y) for c in cents]), predicate='within')[0].tolist())
    for i in inside:
        dist, k, a = metas[i]
        agg[dist]['area_in8m'][k] += a

    # 其他統計
    roadplan = {r['行政區']: float(r['面積_平方公尺']) for r in read_csv(fetch('roadplan', args.cache))}
    pub = {r['分區']: r for r in read_csv(fetch('pubspace', args.cache), 'big5')}
    pop = {}
    for r in read_csv(fetch('pop', args.cache)):
        site = r.get('site_id', '')
        if site.startswith('臺北市'):
            pop[site[3:]] = (int(r['people_total']), float(r['area']))
    # 機動車輛登記數：每月、每區一列；取最新月份，另保留全市的月別序列
    vrows = read_csv(fetch('vehicles', args.cache))
    num = lambda v: int(str(v).replace(',', '') or 0)
    def veh(r):
        return {'car': num(r['機動車輛登記數/汽車/合計']), 'moto': num(r['機動車輛登記數/機車']),
                'small_private': num(r['機動車輛登記數/汽車/小型車自用']),
                'small_business': num(r['機動車輛登記數/汽車/小型車營業用'])}
    periods = list(dict.fromkeys(r['統計期'] for r in vrows))
    latest = periods[-1]
    vehicles = {r['行政區別']: veh(r) for r in vrows if r['統計期'] == latest}
    vseries = [dict(period=r['統計期'].replace(' ', ''), **veh(r)) for r in vrows if r['行政區別'] == '總計']

    lots = json.loads(fetch('lots', args.cache).decode('utf-8-sig'))['data']['park']
    lot_agg = collections.defaultdict(collections.Counter)
    for p in lots:
        if p.get('area') in DISTRICT_EN:
            lot_agg[p['area']]['lots'] += 1
            lot_agg[p['area']]['car'] += int(p.get('totalcar') or 0)
            lot_agg[p['area']]['moto'] += int(p.get('totalmotor') or 0)

    rows = []
    for dist in DISTRICTS:
        a, c, lp = agg[dist], comp[dist], pop[dist]
        rows.append({
            'district': dist, 'en': DISTRICT_EN[dist],
            'population': lp[0], 'land_km2': lp[1],
            'road_m2': roadplan[dist],
            'road8m': {k: round(c[k]) for k in ('area', 'sidewalk', 'median', 'ditch')},
            'slots': {k: a['n'][k] for k in CLASSES},
            'slot_m2': {k: round(a['area'][k]) for k in CLASSES},
            'slot_m2_in8m': {k: round(a['area_in8m'][k]) for k in CLASSES},
            'charged': {'car': int(pub[dist]['汽車路邊總數值（格）']), 'moto': int(pub[dist]['機車路邊總數值（格）'])},
            'offstreet': dict(lot_agg[dist]),
            'vehicles': vehicles[dist],
        })

    tot = lambda f: sum(f(r) for r in rows)
    out = {
        'meta': {
            'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'slots_file': slot_stem,
            'slots_snapshot': f'{slot_stem[7:11]}-{slot_stem[11:13]}-{slot_stem[13:15]}',
            'lots_updated': json.loads(fetch('lots', args.cache).decode('utf-8-sig'))['data']['UPDATETIME'],
            'road8m_survey': '103–105年（2014–2016）',
            'other_codes': dict(other_codes.most_common()),
            'classes': {'car': sorted(CAR, key=int), 'moto': sorted(MOTO, key=int), 'zone': sorted(ZONE, key=int)},
            'totals': {
                'land_km2': round(tot(lambda r: r['land_km2']), 4),
                'population': tot(lambda r: r['population']),
                'road_m2': tot(lambda r: r['road_m2']),
                'road8m': {k: tot(lambda r: r['road8m'][k]) for k in ('area', 'sidewalk', 'median', 'ditch')},
                'slots': {k: tot(lambda r: r['slots'][k]) for k in CLASSES},
                'slot_m2': {k: tot(lambda r: r['slot_m2'][k]) for k in CLASSES},
                'slot_m2_in8m': {k: tot(lambda r: r['slot_m2_in8m'][k]) for k in CLASSES},
                'charged': {k: tot(lambda r: r['charged'][k]) for k in ('car', 'moto')},
                'offstreet': {k: tot(lambda r: r['offstreet'].get(k, 0)) for k in ('lots', 'car', 'moto')},
                'vehicles': vehicles['總計'],
            },
            'vehicles_period': latest.replace(' ', ''),
            'vehicles_series': vseries,
            'sources': PAGES,
        },
        'districts': rows,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    T = out['meta']['totals']
    print(f"寫入 {OUT_PATH}：汽車格 {T['slots']['car']:,}（{T['slot_m2']['car'] / 1e4:.1f} 公頃）、"
          f"機車格 {T['slots']['moto']:,}（{T['slot_m2']['moto'] / 1e4:.1f} 公頃）", file=sys.stderr)


if __name__ == '__main__':
    main()
