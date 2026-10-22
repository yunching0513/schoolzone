# 全國人行道資料 · Taiwan National Sidewalk Inventory

互動式人行道地圖頁面（`index.html`），呈現全國各縣市 2026 年 6 月人行道路網的淨寬健檢、
街景比對、A1 死亡事故點位與電線桿障礙圖層。

此頁面自 [`taiwan-mobility-atlas`](https://github.com/yunching0513/taiwan-mobility-atlas)
擷取而來，連同其執行所需的資料與資源檔一併複製為獨立頁面。

線上原始版本：<https://yunching0513.github.io/taiwan-mobility-atlas/sidewalk.html>

## 內容結構

| 路徑 | 說明 |
| --- | --- |
| `index.html` | 主頁面（原 `sidewalk.html`） |
| `data/sidewalks26/*.geojson` | 各縣市人行道路網（2026 年 6 月，依需載入） |
| `data/poles/*.json` | 台電電線桿圖層（依需載入） |
| `data/national_points.js` | A1 死亡事故點位圖層 |
| `data/sidewalk_national.js` | 全國人行道統計摘要 |
| `data/cities.js`, `data/townships_en.js` | 縣市／鄉鎮對照 |
| `data/gmaps_key.js` | Google Maps API 金鑰（街景比對用；受網域限制） |
| `data/basemap_config.js` | CARTO 底圖金鑰（留空＝改用國土測繪中心底圖） |
| `data/tiles/living_streets.pmtiles` | 全台生活街道候選（≤15 m，估算路寬分級 A/B/C）向量圖磚，來自 [Taiwanwonnerf](https://github.com/yunching0513/202609---Taiwanwonnerf) |
| `data/tiles/hierarchy.pmtiles` | 道路功能層級（Sustainable Safety：Through／Distributor）向量圖磚 |
| `data/tiles/*_stats.json`, `living_streets_summary.json` | 上述圖層之長度統計（圖例用） |
| `assets/protomaps-leaflet.js` | protomaps-leaflet 4.0.1（在 Leaflet 上繪製 PMTiles 向量圖磚） |
| `assets/ppgis.js`, `assets/ppgis-ui.js`, `assets/ppgis.css` | 公民科學標註（PPGIS）客戶端與介面 |
| `data/ppgis_config.js` | PPGIS 後端設定（**預設留空＝功能關閉**） |
| `supabase/` | PPGIS 資料庫 migration、seed 與部署說明 |
| `assets/visits.js` | 頁尾造訪人次 |
| `road-safety.html` | 國際比較：道路安全 × 人均 GDP 四象限 |
| `scripts/build_road_safety.py` | 上一頁的資料建置（WHO／IMF／World Bank；僅用標準函式庫） |
| `tests/*.spec.js` | 端對端測試（Playwright） |
| `districts.geojson`, `populations.json` | 行政區界與人口 |
| `assets/`, `manifest.webmanifest`, `sw.js` | 圖示、PWA manifest 與 service worker |

## 生活街道與道路層級圖層

「Advocacy」列新增三個切換：**🛣 生活街道候選 ≤12 m**（≤8 m 巷弄、8–12 m 社區街道）、**＋12–15 m 邊界**、**🧭 道路層級 Sustainable Safety**（Through＝國道／快速公路、Distributor＝省／縣／鄉道與市區幹道、Access＝其餘市區道路）。
路寬為 OSM 路網推估（width 標籤→lanes→路名慣例→道路等級預設），點擊路段可見估算值與依據。資料處理流程與各縣市 Shapefile 見 Taiwanwonnerf repo；更新圖磚時直接覆蓋 `data/tiles/*.pmtiles` 與統計 JSON 即可。

## 公民科學標註（PPGIS）

把這個頁面從唯讀的客觀環境量測工具，升級為可寫入的**兒童獨立移動性（CIM）**公民科學平台：
參與者以工作坊代碼加入（不需帳號、不留姓名），在地圖上留下標註
（「這個路口我不敢過」「有大人會看著我」「我想把這裡改成…」）、畫出自己的通學路徑
（含**是否有大人陪同**——CIM 的直接測量），並可填答 Hillman 六項獨立移動授權量表。

平台原本算的是孩子**理論上**走得到多遠；這一層蒐集孩子**實際上**走到哪、敢不敢走。
兩者的落差由 `v_school_objective_vs_perceived` 直接併成一列，是研究的核心分析單元。

資料模型、研究倫理設計與權限模型見 [`docs/ppgis-data-model.md`](docs/ppgis-data-model.md)，
部署步驟見 [`supabase/README.md`](supabase/README.md)。

> `data/ppgis_config.js` 留空時整個模組靜默停用，地圖其他功能完全不受影響。

## 造訪人次

頁尾顯示累計造訪次數、約略不重複訪客數與今日次數。

伺服器端**只存每日彙總計數**（`supabase/migrations/0004_site_visits.sql`）——
沒有 IP、沒有 user agent、沒有瀏覽器指紋、沒有每人一列的紀錄。
「不重複訪客」完全由瀏覽器端判斷（`localStorage` 旗標），第一次造訪才把
`p_new=true` 送上去，伺服器收到的只是「請加一」；清除瀏覽器資料會被重新算成
新訪客，所以是約略值而非分析工具。同一分頁重新整理不重複計數。

後端未設定或連不上時整個計數器不出現，不會在頁尾留下壞掉的數字。

## 國際比較：道路安全 × 國家所得

`road-safety.html` 以四象限呈現各國道路交通死亡率與人均 GDP，聚焦台灣與人口密度、氣候、
文化相近的國家：

| 象限 | 位置 | 定義 |
|---|---|---|
| ① | 右上 | 富裕國家｜低交通死亡率 |
| ② | 左上 | 中低收入國家｜低交通死亡率 |
| ③ | 右下 | 富裕國家｜高交通死亡率 |
| ④ | 左下 | 中低收入國家｜高交通死亡率 |

縱軸倒置（越往上越安全）。兩條門檻線可拖曳，所有統計即時重算。

**資料**：WHO GHO `RS_198`（道路交通死亡率估計值）、IMF WEO `NGDPDPC`（人均 GDP，含台灣）、
World Bank（人口密度、所得分組）。台灣不在 WHO 資料中，改用交通部 30 日死亡人數 ÷ IMF 人口。

**建置**（需要能連到 `ghoapi.azureedge.net`、`www.imf.org`、`api.worldbank.org`）：

```bash
python3 scripts/build_road_safety.py          # 產生 data/road_safety_gdp.json
```

只用 Python 標準函式庫。資料檔產生之前，主頁不會顯示這一頁的入口。

目前資料為 **2023 年**（WHO 最新年份），181 國。台灣的 30 日死亡人數取自交通部
道安資訊查詢網（各縣市加總，2023 年 3,023 人），腳本每次執行都會向該來源即時重新查詢；
土地面積依行政院國情簡介（36,197.3371 km²）。

**大洲只分 4 組**（亞洲・大洋洲／歐洲／美洲／非洲）：散佈圖上任兩點都可能相鄰，
以色盲模擬驗證，8 種分類色取 6 種的 28 種組合全部無法通過門檻，4 色才能通過；
並以形狀（圓、方、三角、菱）做第二編碼。

## 底圖

CARTO 自 2026 年起要求 API 金鑰，沒有金鑰的圖磚會被印上「API KEY REQUIRED」。
地圖依序嘗試三個來源，前幾張圖磚全部失敗就自動換下一個：

1. **CARTO 淺色底圖**——只在 `data/basemap_config.js` 填了 `cartoKey` 時使用。
   金鑰免費（非商業用途每月 500 萬次圖磚），在 <https://carto.com/basemaps/apikey> 填 email 即寄到。
2. **內政部國土測繪中心「臺灣通用電子地圖」**——免金鑰，以 CSS 濾鏡轉灰階。
3. **OpenStreetMap**——免金鑰，同樣轉灰階。

填入或更換金鑰後，記得把 `sw.js` 的 `VERSION` 加一。

## 本地預覽

```bash
python3 -m http.server 8848   # PMTiles 需 HTTP Range；若圖層不顯示請改用 `pip install rangehttpserver && python3 -m RangeHTTPServer 8848`
# 開啟 http://127.0.0.1:8848/
```

> 地圖圖磚、Leaflet 與 Google 街景由外部服務載入，預覽時需要對外網路連線。

## 授權

見 [`LICENSE`](./LICENSE)。
