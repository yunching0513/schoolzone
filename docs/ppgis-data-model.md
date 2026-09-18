# 公民科學 PPGIS 資料模型

把「打造夢想街道」從**唯讀的客觀環境量測工具**，升級為可寫入的
**兒童獨立移動性（Child Independent Mobility, CIM）公民科學平台**。

研究上的意義：平台原本算的是「孩子**理論上**走得到多遠」（沿人行道網路的 15 分鐘等時圈），
現在可以同時蒐集「孩子**實際上**走到哪、敢不敢走、為什麼不敢」。
**兩者的落差**就是分析的核心，`v_school_objective_vs_perceived` 這個檢視直接把它併成一列。

---

## 檔案

| 檔案 | 作用 |
|---|---|
| `supabase/migrations/0001_ppgis_core.sql` | 資料表、列舉型別、索引 |
| `supabase/migrations/0002_rls_and_rpc.sql` | RLS 權限與 SECURITY DEFINER 寫入函式 |
| `supabase/migrations/0003_taxonomy_and_views.sql` | 標註語彙、量表題目、徽章、分析檢視 |
| `supabase/seed/0100_schools.sql` | 4,336 所學校與客觀基線指標 |
| `data/ppgis_config.js` | 前端設定（**預設留空＝功能關閉**） |
| `assets/ppgis.js` | 客戶端（PostgREST + 離線佇列） |
| `assets/ppgis-ui.js` | 地圖上的標註／畫路／圖層介面 |
| `assets/ppgis.css` | 介面樣式 |
| `tests/ppgis.spec.js` | 端對端測試（Playwright，模擬後端） |

---

## 資料表

```
schools ──┬── workshops ──┬── participants ──┬── consent_records
          │               │                  ├── licence_responses ── licences
          │               │                  └── mission_completions ── missions ── badges
          │               ├── annotations ── annotation_kinds
          │               ├── routes
          │               └── album_items ── remakes
          └────────────────────┘
```

### 對應到研究構念

| 構念 | 資料表／欄位 |
|---|---|
| 客觀步行環境 | `schools.deficit_score / connectivity / reach_km / no_sidewalk` |
| 主觀感受（可供性） | `annotations.kind` → `annotation_kinds.valence` |
| 感受強度 | `annotations.severity`（1–5） |
| **實際獨立移動** | `routes.accompany`（`alone` / `with_peers` / `with_sibling` 視為獨立） |
| **家長授權** | `licence_responses`（Hillman 六項，`wave` 分前後測） |
| 通學方式 | `routes.mode` |
| 改造意願 | `annotations.kind='idea'` → `album_items` → `remakes` |

### 標註語彙

刻意用兒童聽得懂的話，不用工程術語。分三群：

- **負向（10 項）** 阻礙獨立移動：`scary_crossing` 這個路口我不敢過、`no_sidewalk` 沒有人行道要走馬路、
  `blocked_sidewalk` 人行道被擋住、`scooter_on_walk` 機車騎上人行道、`fast_traffic` 車開很快、
  `bad_visibility`、`dark_at_night`、`flooding`、`step_or_slope`、`makes_me_uneasy`
- **正向（6 項）** 已實現的可供性：`safe_crossing` 這裡過馬路很安心、`fun_place` 這裡很好玩想停下來、
  `friendly_eyes` 有大人會看著我（街道眼）、`shade_green`、`meet_friends`、`my_shortcut` 我的祕密捷徑
- **提案（1 項）** `idea` 我想把這裡改成…（接 AI 街景生成器）

> 只問危險，會做出一份恐懼地圖而不是 CIM 地圖 —— 正向項目是必要的對照。
> 部分負向項目有 `objective_field`，指向平台既有的工程指標，供「主觀 vs 客觀」比對。

---

## 研究倫理設計

平台的參與者包含兒童，資料模型本身就要擋住不該蒐集的東西：

1. **兒童不需要帳號、不留姓名。** 以工作坊短代碼加入，系統自動配發化名
   （如「石虎-A1B2」）。`participants` 表沒有姓名、學號或 email 欄位。
2. **不儲存住家座標。** 只存 `home_distance_band`（四級距離組距）。
   畫通學路徑時，客戶端會**自動裁掉住家端最後 150 公尺**才送出。
3. **標註記錄的是地點，不是兒童的行蹤。** 沒有背景定位、沒有軌跡追蹤。
4. **裝置識別只存雜湊。** 本機隨機值的 SHA-256，用於同一裝置續填，無法回推。
5. **同意獨立稽核。** `consent_records` 與 `participants` 分開，記錄同意書版本與時間。
   `workshops.irb_ref` 存 IRB 核准文號。
6. **預設不公開。** 所有投稿 `status='pending'`，研究者審核後才變 `published`；
   匿名使用者永遠只讀得到 `published` 的內容，且讀不到 `participants`。

> ⚠️ 街景截圖可能含可辨識的人臉與門牌。`album_items` 同樣受審核控管，
> 公開發布前應建立去識別化流程。

---

## 權限模型

- 所有資料表一律開啟 RLS，**預設拒絕**。
- **匿名使用者不能直接 INSERT 任何資料表**，只能呼叫 SECURITY DEFINER 函式：
  `join_workshop` / `submit_annotation` / `submit_route` / `submit_licences` /
  `record_consent` / `save_album_item` / `save_remake` / `nearest_school`。
- 函式會驗證參與者憑證、檢查場次是否開放、擋掉台灣範圍外的座標，
  並限制投稿頻率（每人每場 200 則、每分鐘 10 則）。
- 個體層級資料（`participants`、`licence_responses`、`consent_records`）
  只有列在 `researchers` 表的登入帳號讀得到。

`anonKey` 是公開金鑰，設計上就會出現在前端原始碼；真正的防線是上面這一層。

---

## 分析檢視

| 檢視 | 用途 |
|---|---|
| `v_school_objective_vs_perceived` | **核心**：每校一列，客觀指標 + 正／負向標註數 + 平均嚴重度 |
| `v_route_independence` | 每條通學路徑是否為獨立移動，含年級與距離組距 |
| `v_licence_summary` | 六項授權的前後測允許比例與家長期待年齡 |
| `v_annotations_public` | 公開地圖圖層用（不含參與者身分） |
| `v_workshop_progress` | 工作坊現場儀表板 |

---

## 部署

見 `supabase/README.md`。設定填好前，平台維持目前的唯讀行為，
標註介面不會出現，其他功能完全不受影響。
