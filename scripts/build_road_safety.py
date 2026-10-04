#!/usr/bin/env python3
"""
道路安全 × 人均 GDP 四象限 —— 資料建置

從權威來源抓取資料，合併成網頁用的 data/road_safety_gdp.json：

  交通死亡率   WHO Global Health Observatory，指標 RS_198
               Estimated road traffic death rate (per 100 000 population)
               ——《Global Status Report on Road Safety》所用的同一套估計值
  人均 GDP     IMF World Economic Outlook（DataMapper API），NGDPDPC，現價美元
               ——IMF 有收錄台灣，所以台灣與各國用同一個 GDP 來源
  人口         IMF WEO，LP（百萬人）——只用來計算台灣的死亡率
  人口密度     World Bank WDI，EN.POP.DNST（人／平方公里）
  所得分組     World Bank 國家分類（high / upper-middle / lower-middle / low income）

台灣不在 WHO 與 World Bank 的資料中，死亡數改用交通部「30 日死亡人數」，
除以 IMF 同年人口換算成每十萬人死亡率。見下方 TAIWAN 區塊。

只使用 Python 標準函式庫，不需要安裝任何套件：

    python3 scripts/build_road_safety.py            # 自動取 WHO 最新年份
    python3 scripts/build_road_safety.py --year 2021
"""
import argparse
import datetime as dt
import json
import os
import sys
import urllib.request

OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'road_safety_gdp.json')

WHO_RATE = 'https://ghoapi.azureedge.net/api/RS_198'
IMF_GDP = 'https://www.imf.org/external/datamapper/api/v1/NGDPDPC'
IMF_POP = 'https://www.imf.org/external/datamapper/api/v1/LP'
WB_COUNTRIES = 'https://api.worldbank.org/v2/country?format=json&per_page=400'
WB_DENSITY = 'https://api.worldbank.org/v2/country/all/indicator/EN.POP.DNST?format=json&per_page=20000&date={y}'

# ---------------------------------------------------------------------------
# 台灣（WHO／World Bank 均未收錄）
#
# ⚠️ 以下數值由 Claude 依記憶填入，建置環境當時無法連線核對。
#    公開發布前請以官方來源逐一確認：
#    - 30 日死亡人數：交通部「道安資訊查詢網」https://roadsafety.tw/
#                     或交通部統計查詢網 https://stat.motc.gov.tw/
#    - 土地面積：內政部統計（臺閩地區土地面積）
# ---------------------------------------------------------------------------
TAIWAN = {
    'deaths_30d': {2021: 2962, 2022: 3085},
    'area_km2': 36197.07,
    'verified': False,      # 核對完畢後改成 True
}

# World Bank 高所得門檻（GNI per capita, Atlas method, 現價美元），依「資料年」
# 來源：https://datahelpdesk.worldbank.org/knowledgebase/articles/906519
# 注意：分類用的是 GNI，本圖橫軸是 GDP；門檻線是近似參考，頁面可拖曳調整。
WB_HIGH_INCOME = {2019: 12535, 2020: 12695, 2021: 13205, 2022: 13845, 2023: 14005}

# 與台灣比較的焦點國家與選取理由（「密度相近」由資料自動判定，不在此手動指定）
#   culture   漢字文化圈／東亞
#   climate   熱帶或亞熱帶季風氣候
#   moto      機車為主要運具
#   benchmark 道路安全政策標竿
FOCUS = {
    'JPN': ['culture'],
    'KOR': ['culture'],
    'CHN': ['culture'],
    'SGP': ['culture', 'climate'],
    'VNM': ['culture', 'climate', 'moto'],
    'THA': ['climate', 'moto'],
    'MYS': ['climate', 'moto'],
    'IDN': ['climate', 'moto'],
    'PHL': ['climate'],
    'LKA': ['climate'],
    'BGD': ['climate'],
    'NLD': ['benchmark'],     # Sustainable Safety（Duurzaam Veilig）
    'SWE': ['benchmark'],     # Vision Zero 發源地
    'BEL': [],                # 人口密度相近
    'ISR': [],                # 人口密度相近
}
TAIWAN_TAGS = ['culture', 'climate', 'moto']
DENSITY_BAND = (0.5, 2.0)     # 台灣密度的 0.5–2 倍視為「密度相近」

# 大洲分組。只分 4 組，因為散佈圖上任兩點都可能相鄰，經色盲模擬驗證，
# 6 種顏色無法兩兩區分（見 road-safety.html 的方法說明）。
#   asia = 亞洲＋大洋洲；americas = 北美＋中南美
# ISO3: (group, 中文名, English name)
COUNTRIES = {
    'ABW': ('americas', '荷屬阿魯巴', 'Aruba'),
    'AFG': ('asia', '阿富汗', 'Afghanistan'),
    'AGO': ('africa', '安哥拉', 'Angola'),
    'AIA': ('americas', '安奎拉', 'Anguilla'),
    'ALA': ('europe', '奧蘭群島', 'Åland Islands'),
    'ALB': ('europe', '阿爾巴尼亞', 'Albania'),
    'AND': ('europe', '安道爾', 'Andorra'),
    'ARE': ('asia', '阿拉伯聯合大公國', 'United Arab Emirates'),
    'ARG': ('americas', '阿根廷', 'Argentina'),
    'ARM': ('asia', '亞美尼亞', 'Armenia'),
    'ASM': ('asia', '美屬薩摩亞', 'American Samoa'),
    'ATG': ('americas', '安地卡及巴布達', 'Antigua & Barbuda'),
    'AUS': ('asia', '澳洲', 'Australia'),
    'AUT': ('europe', '奧地利', 'Austria'),
    'AZE': ('asia', '亞塞拜然', 'Azerbaijan'),
    'BDI': ('africa', '蒲隆地', 'Burundi'),
    'BEL': ('europe', '比利時', 'Belgium'),
    'BEN': ('africa', '貝南', 'Benin'),
    'BES': ('americas', '荷蘭加勒比區', 'Caribbean Netherlands'),
    'BFA': ('africa', '布吉納法索', 'Burkina Faso'),
    'BGD': ('asia', '孟加拉', 'Bangladesh'),
    'BGR': ('europe', '保加利亞', 'Bulgaria'),
    'BHR': ('asia', '巴林', 'Bahrain'),
    'BHS': ('americas', '巴哈馬', 'Bahamas'),
    'BIH': ('europe', '波士尼亞與赫塞哥維納', 'Bosnia & Herzegovina'),
    'BLM': ('americas', '聖巴瑟米', 'St. Barthélemy'),
    'BLR': ('europe', '白俄羅斯', 'Belarus'),
    'BLZ': ('americas', '貝里斯', 'Belize'),
    'BMU': ('americas', '百慕達', 'Bermuda'),
    'BOL': ('americas', '玻利維亞', 'Bolivia'),
    'BRA': ('americas', '巴西', 'Brazil'),
    'BRB': ('americas', '巴貝多', 'Barbados'),
    'BRN': ('asia', '汶萊', 'Brunei'),
    'BTN': ('asia', '不丹', 'Bhutan'),
    'BWA': ('africa', '波札那', 'Botswana'),
    'CAF': ('africa', '中非共和國', 'Central African Republic'),
    'CAN': ('americas', '加拿大', 'Canada'),
    'CCK': ('asia', '科克斯（基靈）群島', 'Cocos (Keeling) Islands'),
    'CHE': ('europe', '瑞士', 'Switzerland'),
    'CHL': ('americas', '智利', 'Chile'),
    'CHN': ('asia', '中國', 'China'),
    'CIV': ('africa', '象牙海岸', 'Côte d’Ivoire'),
    'CMR': ('africa', '喀麥隆', 'Cameroon'),
    'COD': ('africa', '剛果（金夏沙）', 'Congo - Kinshasa'),
    'COG': ('africa', '剛果（布拉薩）', 'Congo - Brazzaville'),
    'COK': ('asia', '庫克群島', 'Cook Islands'),
    'COL': ('americas', '哥倫比亞', 'Colombia'),
    'COM': ('africa', '葛摩', 'Comoros'),
    'CPV': ('africa', '維德角', 'Cape Verde'),
    'CRI': ('americas', '哥斯大黎加', 'Costa Rica'),
    'CUB': ('americas', '古巴', 'Cuba'),
    'CUW': ('americas', '庫拉索', 'Curaçao'),
    'CXR': ('asia', '聖誕島', 'Christmas Island'),
    'CYM': ('americas', '開曼群島', 'Cayman Islands'),
    'CYP': ('asia', '賽普勒斯', 'Cyprus'),
    'CZE': ('europe', '捷克', 'Czechia'),
    'DEU': ('europe', '德國', 'Germany'),
    'DJI': ('africa', '吉布地', 'Djibouti'),
    'DMA': ('americas', '多米尼克', 'Dominica'),
    'DNK': ('europe', '丹麥', 'Denmark'),
    'DOM': ('americas', '多明尼加共和國', 'Dominican Republic'),
    'DZA': ('africa', '阿爾及利亞', 'Algeria'),
    'ECU': ('americas', '厄瓜多', 'Ecuador'),
    'EGY': ('africa', '埃及', 'Egypt'),
    'ERI': ('africa', '厄利垂亞', 'Eritrea'),
    'ESP': ('europe', '西班牙', 'Spain'),
    'EST': ('europe', '愛沙尼亞', 'Estonia'),
    'ETH': ('africa', '衣索比亞', 'Ethiopia'),
    'FIN': ('europe', '芬蘭', 'Finland'),
    'FJI': ('asia', '斐濟', 'Fiji'),
    'FLK': ('americas', '福克蘭群島', 'Falkland Islands'),
    'FRA': ('europe', '法國', 'France'),
    'FRO': ('europe', '法羅群島', 'Faroe Islands'),
    'FSM': ('asia', '密克羅尼西亞', 'Micronesia'),
    'GAB': ('africa', '加彭', 'Gabon'),
    'GBR': ('europe', '英國', 'United Kingdom'),
    'GEO': ('asia', '喬治亞', 'Georgia'),
    'GGY': ('europe', '根息', 'Guernsey'),
    'GHA': ('africa', '迦納', 'Ghana'),
    'GIB': ('europe', '直布羅陀', 'Gibraltar'),
    'GIN': ('africa', '幾內亞', 'Guinea'),
    'GLP': ('americas', '瓜地洛普', 'Guadeloupe'),
    'GMB': ('africa', '甘比亞', 'Gambia'),
    'GNB': ('africa', '幾內亞比索', 'Guinea-Bissau'),
    'GNQ': ('africa', '赤道幾內亞', 'Equatorial Guinea'),
    'GRC': ('europe', '希臘', 'Greece'),
    'GRD': ('americas', '格瑞那達', 'Grenada'),
    'GRL': ('americas', '格陵蘭', 'Greenland'),
    'GTM': ('americas', '瓜地馬拉', 'Guatemala'),
    'GUF': ('americas', '法屬圭亞那', 'French Guiana'),
    'GUM': ('asia', '關島', 'Guam'),
    'GUY': ('americas', '蓋亞那', 'Guyana'),
    'HKG': ('asia', '中國香港特別行政區', 'Hong Kong SAR China'),
    'HND': ('americas', '宏都拉斯', 'Honduras'),
    'HRV': ('europe', '克羅埃西亞', 'Croatia'),
    'HTI': ('americas', '海地', 'Haiti'),
    'HUN': ('europe', '匈牙利', 'Hungary'),
    'IDN': ('asia', '印尼', 'Indonesia'),
    'IMN': ('europe', '曼島', 'Isle of Man'),
    'IND': ('asia', '印度', 'India'),
    'IOT': ('asia', '英屬印度洋領地', 'British Indian Ocean Territory'),
    'IRL': ('europe', '愛爾蘭', 'Ireland'),
    'IRN': ('asia', '伊朗', 'Iran'),
    'IRQ': ('asia', '伊拉克', 'Iraq'),
    'ISL': ('europe', '冰島', 'Iceland'),
    'ISR': ('asia', '以色列', 'Israel'),
    'ITA': ('europe', '義大利', 'Italy'),
    'JAM': ('americas', '牙買加', 'Jamaica'),
    'JEY': ('europe', '澤西島', 'Jersey'),
    'JOR': ('asia', '約旦', 'Jordan'),
    'JPN': ('asia', '日本', 'Japan'),
    'KAZ': ('asia', '哈薩克', 'Kazakhstan'),
    'KEN': ('africa', '肯亞', 'Kenya'),
    'KGZ': ('asia', '吉爾吉斯', 'Kyrgyzstan'),
    'KHM': ('asia', '柬埔寨', 'Cambodia'),
    'KIR': ('asia', '吉里巴斯', 'Kiribati'),
    'KNA': ('americas', '聖克里斯多福及尼維斯', 'St. Kitts & Nevis'),
    'KOR': ('asia', '南韓', 'South Korea'),
    'KWT': ('asia', '科威特', 'Kuwait'),
    'LAO': ('asia', '寮國', 'Laos'),
    'LBN': ('asia', '黎巴嫩', 'Lebanon'),
    'LBR': ('africa', '賴比瑞亞', 'Liberia'),
    'LBY': ('africa', '利比亞', 'Libya'),
    'LCA': ('americas', '聖露西亞', 'St. Lucia'),
    'LIE': ('europe', '列支敦斯登', 'Liechtenstein'),
    'LKA': ('asia', '斯里蘭卡', 'Sri Lanka'),
    'LSO': ('africa', '賴索托', 'Lesotho'),
    'LTU': ('europe', '立陶宛', 'Lithuania'),
    'LUX': ('europe', '盧森堡', 'Luxembourg'),
    'LVA': ('europe', '拉脫維亞', 'Latvia'),
    'MAC': ('asia', '中國澳門特別行政區', 'Macao SAR China'),
    'MAF': ('americas', '法屬聖馬丁', 'St. Martin'),
    'MAR': ('africa', '摩洛哥', 'Morocco'),
    'MCO': ('europe', '摩納哥', 'Monaco'),
    'MDA': ('europe', '摩爾多瓦', 'Moldova'),
    'MDG': ('africa', '馬達加斯加', 'Madagascar'),
    'MDV': ('asia', '馬爾地夫', 'Maldives'),
    'MEX': ('americas', '墨西哥', 'Mexico'),
    'MHL': ('asia', '馬紹爾群島', 'Marshall Islands'),
    'MKD': ('europe', '北馬其頓', 'North Macedonia'),
    'MLI': ('africa', '馬利', 'Mali'),
    'MLT': ('europe', '馬爾他', 'Malta'),
    'MMR': ('asia', '緬甸', 'Myanmar (Burma)'),
    'MNE': ('europe', '蒙特內哥羅', 'Montenegro'),
    'MNG': ('asia', '蒙古', 'Mongolia'),
    'MNP': ('asia', '北馬利安納群島', 'Northern Mariana Islands'),
    'MOZ': ('africa', '莫三比克', 'Mozambique'),
    'MRT': ('africa', '茅利塔尼亞', 'Mauritania'),
    'MSR': ('americas', '蒙哲臘', 'Montserrat'),
    'MTQ': ('americas', '馬丁尼克', 'Martinique'),
    'MUS': ('africa', '模里西斯', 'Mauritius'),
    'MWI': ('africa', '馬拉威', 'Malawi'),
    'MYS': ('asia', '馬來西亞', 'Malaysia'),
    'MYT': ('africa', '馬約特島', 'Mayotte'),
    'NAM': ('africa', '納米比亞', 'Namibia'),
    'NCL': ('asia', '新喀里多尼亞', 'New Caledonia'),
    'NER': ('africa', '尼日', 'Niger'),
    'NFK': ('asia', '諾福克島', 'Norfolk Island'),
    'NGA': ('africa', '奈及利亞', 'Nigeria'),
    'NIC': ('americas', '尼加拉瓜', 'Nicaragua'),
    'NIU': ('asia', '紐埃島', 'Niue'),
    'NLD': ('europe', '荷蘭', 'Netherlands'),
    'NOR': ('europe', '挪威', 'Norway'),
    'NPL': ('asia', '尼泊爾', 'Nepal'),
    'NRU': ('asia', '諾魯', 'Nauru'),
    'NZL': ('asia', '紐西蘭', 'New Zealand'),
    'OMN': ('asia', '阿曼', 'Oman'),
    'PAK': ('asia', '巴基斯坦', 'Pakistan'),
    'PAN': ('americas', '巴拿馬', 'Panama'),
    'PER': ('americas', '秘魯', 'Peru'),
    'PHL': ('asia', '菲律賓', 'Philippines'),
    'PLW': ('asia', '帛琉', 'Palau'),
    'PNG': ('asia', '巴布亞紐幾內亞', 'Papua New Guinea'),
    'POL': ('europe', '波蘭', 'Poland'),
    'PRI': ('americas', '波多黎各', 'Puerto Rico'),
    'PRK': ('asia', '北韓', 'North Korea'),
    'PRT': ('europe', '葡萄牙', 'Portugal'),
    'PRY': ('americas', '巴拉圭', 'Paraguay'),
    'PSE': ('asia', '巴勒斯坦自治區', 'Palestinian Territories'),
    'PYF': ('asia', '法屬玻里尼西亞', 'French Polynesia'),
    'QAT': ('asia', '卡達', 'Qatar'),
    'REU': ('africa', '留尼旺', 'Réunion'),
    'ROU': ('europe', '羅馬尼亞', 'Romania'),
    'RUS': ('europe', '俄羅斯', 'Russia'),
    'RWA': ('africa', '盧安達', 'Rwanda'),
    'SAU': ('asia', '沙烏地阿拉伯', 'Saudi Arabia'),
    'SDN': ('africa', '蘇丹', 'Sudan'),
    'SEN': ('africa', '塞內加爾', 'Senegal'),
    'SGP': ('asia', '新加坡', 'Singapore'),
    'SGS': ('americas', '南喬治亞與南三明治群島', 'South Georgia & South Sandwich Islands'),
    'SHN': ('africa', '聖赫勒拿島', 'St. Helena'),
    'SJM': ('europe', '挪威屬斯瓦巴及尖棉', 'Svalbard & Jan Mayen'),
    'SLB': ('asia', '索羅門群島', 'Solomon Islands'),
    'SLE': ('africa', '獅子山', 'Sierra Leone'),
    'SLV': ('americas', '薩爾瓦多', 'El Salvador'),
    'SMR': ('europe', '聖馬利諾', 'San Marino'),
    'SOM': ('africa', '索馬利亞', 'Somalia'),
    'SPM': ('americas', '聖皮埃與密克隆群島', 'St. Pierre & Miquelon'),
    'SRB': ('europe', '塞爾維亞', 'Serbia'),
    'SSD': ('africa', '南蘇丹', 'South Sudan'),
    'STP': ('africa', '聖多美普林西比', 'São Tomé & Príncipe'),
    'SUR': ('americas', '蘇利南', 'Suriname'),
    'SVK': ('europe', '斯洛伐克', 'Slovakia'),
    'SVN': ('europe', '斯洛維尼亞', 'Slovenia'),
    'SWE': ('europe', '瑞典', 'Sweden'),
    'SWZ': ('africa', '史瓦帝尼', 'Eswatini'),
    'SYC': ('africa', '塞席爾', 'Seychelles'),
    'SYR': ('asia', '敘利亞', 'Syria'),
    'TCA': ('americas', '土克斯及開科斯群島', 'Turks & Caicos Islands'),
    'TCD': ('africa', '查德', 'Chad'),
    'TGO': ('africa', '多哥', 'Togo'),
    'THA': ('asia', '泰國', 'Thailand'),
    'TJK': ('asia', '塔吉克', 'Tajikistan'),
    'TKL': ('asia', '托克勞群島', 'Tokelau'),
    'TKM': ('asia', '土庫曼', 'Turkmenistan'),
    'TLS': ('asia', '東帝汶', 'Timor-Leste'),
    'TON': ('asia', '東加', 'Tonga'),
    'TTO': ('americas', '千里達及托巴哥', 'Trinidad & Tobago'),
    'TUN': ('africa', '突尼西亞', 'Tunisia'),
    'TUR': ('asia', '土耳其', 'Türkiye'),
    'TUV': ('asia', '吐瓦魯', 'Tuvalu'),
    'TWN': ('asia', '台灣', 'Taiwan'),
    'TZA': ('africa', '坦尚尼亞', 'Tanzania'),
    'UGA': ('africa', '烏干達', 'Uganda'),
    'UKR': ('europe', '烏克蘭', 'Ukraine'),
    'URY': ('americas', '烏拉圭', 'Uruguay'),
    'USA': ('americas', '美國', 'United States'),
    'UZB': ('asia', '烏茲別克', 'Uzbekistan'),
    'VCT': ('americas', '聖文森及格瑞那丁', 'St. Vincent & Grenadines'),
    'VEN': ('americas', '委內瑞拉', 'Venezuela'),
    'VGB': ('americas', '英屬維京群島', 'British Virgin Islands'),
    'VIR': ('americas', '美屬維京群島', 'U.S. Virgin Islands'),
    'VNM': ('asia', '越南', 'Vietnam'),
    'VUT': ('asia', '萬那杜', 'Vanuatu'),
    'WLF': ('asia', '瓦利斯群島和富圖那群島', 'Wallis & Futuna'),
    'WSM': ('asia', '薩摩亞', 'Samoa'),
    'YEM': ('asia', '葉門', 'Yemen'),
    'ZAF': ('africa', '南非', 'South Africa'),
    'ZMB': ('africa', '尚比亞', 'Zambia'),
    'ZWE': ('africa', '辛巴威', 'Zimbabwe')
}


def get_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'schoolzone-road-safety/1.0'})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def fetch_who():
    """{iso3: {year: (rate, low, high)}}，並回傳 WHO 全球估計值 {year: rate}"""
    data = get_json(WHO_RATE)['value']
    by, glob = {}, {}
    for v in data:
        if v.get('NumericValue') is None:
            continue
        if v.get('Dim1') not in (None, '', 'SEX_BTSX', 'BTSX'):
            continue                      # 只取兩性合計
        y = int(v['TimeDim'])
        rec = (round(v['NumericValue'], 1), v.get('Low'), v.get('High'))
        if v.get('SpatialDimType') == 'COUNTRY':
            by.setdefault(v['SpatialDim'], {})[y] = rec
        elif v.get('SpatialDimType') in ('GLOBAL', 'WORLD') or v.get('SpatialDim') in ('GLOBAL', 'WORLD'):
            glob[y] = rec[0]
    return by, glob


def fetch_imf(url, year):
    d = get_json(f'{url}?periods={year}')
    key = url.rsplit('/', 1)[-1]
    out = {}
    for iso, series in (d.get('values', {}).get(key, {}) or {}).items():
        val = series.get(str(year))
        if val is not None:
            out[iso] = float(val)
    return out


def fetch_wb_meta():
    meta = {}
    for c in get_json(WB_COUNTRIES)[1]:
        if c['region']['value'] == 'Aggregates':
            continue
        meta[c['id']] = c['incomeLevel']['id']        # HIC / UMC / LMC / LIC
    return meta


def fetch_wb_density(year):
    out = {}
    payload = get_json(WB_DENSITY.format(y=year))
    for r in (payload[1] or []):
        if r.get('value') is not None and r.get('countryiso3code'):
            out[r['countryiso3code']] = float(r['value'])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--year', type=int, help='資料年（預設：WHO 最新年份）')
    args = ap.parse_args()

    print('· WHO GHO RS_198 …', flush=True)
    who, who_global = fetch_who()
    years = sorted({y for v in who.values() for y in v})
    year = args.year or years[-1]
    print(f'  WHO 年份 {years[0]}–{years[-1]}，使用 {year}')

    if year not in TAIWAN['deaths_30d']:
        sys.exit(f'✗ TAIWAN["deaths_30d"] 缺少 {year} 年的交通部 30 日死亡人數，請補上後再執行。')
    if year not in WB_HIGH_INCOME:
        sys.exit(f'✗ WB_HIGH_INCOME 缺少 {year} 年的高所得門檻，請補上後再執行。')

    print('· IMF WEO 人均 GDP、人口 …', flush=True)
    gdp = fetch_imf(IMF_GDP, year)
    pop = fetch_imf(IMF_POP, year)
    print('· World Bank 所得分組、人口密度 …', flush=True)
    income = fetch_wb_meta()
    density = fetch_wb_density(year)

    # 台灣
    if 'TWN' not in gdp or 'TWN' not in pop:
        sys.exit('✗ IMF 資料中找不到台灣（TWN）')
    tw_rate = TAIWAN['deaths_30d'][year] / (pop['TWN'] * 1e6) * 1e5
    tw_density = pop['TWN'] * 1e6 / TAIWAN['area_km2']
    lo, hi = tw_density * DENSITY_BAND[0], tw_density * DENSITY_BAND[1]

    out, dropped = [], []
    for iso, (group, zh, en) in COUNTRIES.items():
        if iso == 'TWN':
            rate, low, high = round(tw_rate, 1), None, None
            dens, inc, src = round(tw_density, 1), 'HIC', 'MOTC'
        else:
            rec = who.get(iso, {}).get(year)
            if not rec:
                continue
            rate, low, high = rec
            dens = density.get(iso)
            dens = round(dens, 1) if dens is not None else None
            inc, src = income.get(iso), 'WHO'
        g = gdp.get(iso)
        if g is None:
            dropped.append(iso)
            continue
        tags = list(TAIWAN_TAGS if iso == 'TWN' else FOCUS.get(iso, []))
        if iso != 'TWN' and dens is not None and lo <= dens <= hi:
            tags.append('density')
        out.append({
            'iso3': iso, 'zh': zh, 'en': en, 'group': group,
            'rate': rate, 'rate_low': low, 'rate_high': high, 'rate_source': src,
            'gdp_pc': round(g), 'density': dens, 'income': inc,
            'focus': iso == 'TWN' or iso in FOCUS, 'tags': tags,
        })

    glob = who_global.get(year)
    result = {
        'meta': {
            'year': year,
            'generated': dt.date.today().isoformat(),
            'global_rate': glob,
            'gdp_threshold': WB_HIGH_INCOME[year],
            'taiwan': {
                'deaths_30d': TAIWAN['deaths_30d'][year],
                'population_m': round(pop['TWN'], 3),
                'area_km2': TAIWAN['area_km2'],
                'verified': TAIWAN['verified'],
            },
            'density_band': [round(lo, 1), round(hi, 1)],
            'sources': {
                'rate': 'WHO Global Health Observatory, RS_198 (Estimated road traffic death rate per 100 000 population)',
                'rate_taiwan': '交通部道路交通事故 30 日死亡人數 ÷ IMF WEO 人口',
                'gdp': 'IMF World Economic Outlook, NGDPDPC (GDP per capita, current US$)',
                'density': 'World Bank WDI, EN.POP.DNST',
                'income': 'World Bank country classification',
            },
        },
        'countries': sorted(out, key=lambda c: c['iso3']),
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, separators=(',', ':'))

    print(f'\n✓ 寫入 {os.path.normpath(OUT)}：{len(out)} 國，資料年 {year}')
    print(f'  WHO 全球死亡率：{glob}／十萬人' if glob else '  ⚠ WHO 資料中沒有全球估計值，頁面會改用各國人口加權中位數')
    print(f'  台灣：{tw_rate:.1f}／十萬人，人均 GDP US${gdp["TWN"]:,.0f}，密度 {tw_density:,.0f}／km²')
    if dropped:
        print(f'  有 WHO 死亡率但 IMF 無 GDP 而略過：{", ".join(sorted(dropped))}')
    if not TAIWAN['verified']:
        print('\n  ⚠⚠ 台灣的 30 日死亡人數與土地面積尚未核對（TAIWAN["verified"] = False）。')
        print('      網頁會在台灣的數字旁標示「待核對」，請核對後把 verified 改成 True 再重跑。')


if __name__ == '__main__':
    main()
