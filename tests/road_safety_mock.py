"""以模擬的 WHO／IMF／World Bank 回應跑 scripts/build_road_safety.py 全流程，
產生 road-safety.html 的測試資料。

⚠️ 所有數值都是隨機合成的，不是真實統計——只用來測圖表行為，絕不可放進 data/。

    python3 tests/road_safety_mock.py /tmp/rs.json
    RS_FIXTURE=/tmp/rs.json node tests/road-safety.spec.js
"""
import importlib.util, json, random, sys, os
random.seed(7)
HERE = os.path.dirname(os.path.abspath(__file__))
s = importlib.util.spec_from_file_location('b', os.path.join(HERE, '..', 'scripts', 'build_road_safety.py'))
b = importlib.util.module_from_spec(s); s.loader.exec_module(b)
OUT = sys.argv[1]; b.OUT = OUT
isos = [k for k in b.COUNTRIES if k != 'TWN']
# 讓部分國家沒有 WHO 資料、部分沒有 GDP，測試略過邏輯
who_isos = [i for i in isos if random.random() > 0.15]
inc_of = {}
def fake_gdp(i):
    g = 10 ** random.uniform(2.6, 5.0); inc_of[i] = 'HIC' if g > 13205 else random.choice(['UMC','LMC','LIC']); return g
GDP = {i: fake_gdp(i) for i in isos if random.random() > 0.05}
GDP['TWN'] = 33000.0
def get_json(url):
    if 'ghoapi' in url:
        rows = []
        for i in who_isos:
            for y in (2019, 2020, 2021):
                r = round(random.uniform(1.5, 35), 1)
                rows.append({'SpatialDimType':'COUNTRY','SpatialDim':i,'TimeDim':y,'Dim1':None,
                             'NumericValue':r,'Low':round(r*0.85,1),'High':round(r*1.15,1)})
        rows.append({'SpatialDimType':'GLOBAL','SpatialDim':'GLOBAL','TimeDim':2021,'Dim1':None,'NumericValue':15.0})
        rows.append({'SpatialDimType':'COUNTRY','SpatialDim':'JPN','TimeDim':2021,'Dim1':'SEX_MLE','NumericValue':99.9})  # 應被濾掉
        return {'value': rows}
    if 'NGDPDPC' in url: return {'values': {'NGDPDPC': {i: {'2021': v} for i, v in GDP.items()}}}
    if '/LP' in url:     return {'values': {'LP': {i: {'2021': round(random.uniform(0.1, 300),3)} for i in isos} | {'TWN': {'2021': 23.4}}}}
    if 'EN.POP.DNST' in url:
        return [{}, [{'countryiso3code': i, 'value': 10 ** random.uniform(0.5, 3.4)} for i in isos] + [{'countryiso3code': 'WLD', 'value': 60}]]
    if 'api.worldbank.org/v2/country?' in url:
        return [{}, [{'id': i, 'region': {'value': 'X'}, 'incomeLevel': {'id': inc_of.get(i, 'LMC')}} for i in isos] +
                    [{'id': 'WLD', 'region': {'value': 'Aggregates'}, 'incomeLevel': {'id': 'NA'}}]]
    if 'roadsafety.tw' in url:                     # 交通部道安資訊查詢網：各縣市加總
        return [{'col': ['臺北市'], 'value': 1000}, {'col': ['國道'], 'value': 1962}]
    raise RuntimeError('unexpected url ' + url)
b.get_json = get_json
sys.argv = ['build', '--year', '2021'] if len(sys.argv) < 3 else ['build'] + sys.argv[2:]
b.main()
