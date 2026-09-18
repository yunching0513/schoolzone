# 部署 PPGIS 後端

## 1. 建立專案

在 https://supabase.com 開一個新專案（免費層即可），區域選 **Northeast Asia (Tokyo)**。

## 2. 跑 migration

Dashboard → SQL Editor，**依序**貼上並執行：

```
migrations/0001_ppgis_core.sql
migrations/0002_rls_and_rpc.sql
migrations/0003_taxonomy_and_views.sql
seed/0100_schools.sql          ← 616 KB，4,336 校；可能要分段貼
```

或用 Supabase CLI：

```bash
supabase link --project-ref <your-ref>
supabase db push
psql "$DATABASE_URL" -f supabase/seed/0100_schools.sql
```

`0001` 會啟用 `postgis` 與 `pgcrypto`，Supabase 皆已內建。

## 3. 設定前端

Dashboard → Settings → API，把 **Project URL** 與 **anon public** 金鑰
填進 `data/ppgis_config.js`：

```js
window.PPGIS_CONFIG = {
  url: 'https://xxxxxxxx.supabase.co',
  anonKey: 'eyJhbGciOi...',
};
```

然後把 `sw.js` 的 `VERSION` 加一（例：`vzt-atlas-v5` → `v6`），
否則已安裝 PWA 的使用者會拿到舊快取。

> anon key 是公開金鑰，放在前端是正常的。寫入的防線是 RLS 與
> SECURITY DEFINER 函式（見 `migrations/0002`），不是靠藏金鑰。

## 4. 建立第一場工作坊

```sql
insert into workshops (school_code, title, mode, join_code, facilitator,
                       starts_at, irb_ref, consent_ver)
select code, '中寮國小通學路工作坊', 'onsite', 'ZL2026',
       '<主持人>', now(), '<IRB 文號>', 'v1'
from schools where name like '%中寮國民小學%' limit 1;
```

`join_code` 就是現場發給參與者的代碼（不分大小寫）。

## 5. 加入研究者帳號

先用 Dashboard → Authentication 建一個帳號，然後：

```sql
insert into researchers (user_id, name)
values ('<auth.users 的 uuid>', '<姓名>');
```

沒有這一步，就沒有人讀得到個體層級資料，也沒有人能審核投稿。

## 6. 審核投稿

投稿預設為 `pending`，公開地圖看不到。審核：

```sql
update annotations set status = 'published'
where workshop_id = '<場次 id>' and status = 'pending';
```

現場進度：`select * from v_workshop_progress;`

## 7. 匯出研究資料

```sql
select * from v_school_objective_vs_perceived where n_contributors > 0;
select * from v_route_independence;
select * from v_licence_summary order by wave, licence_key;
```

## 安全檢查

部署後跑一次 Supabase 的 database linter（Dashboard → Advisors → Security）。

預期會看到的**非問題**警告：
- `spatial_ref_sys` 未啟用 RLS、`postgis` 安裝在 public schema —— PostGIS 的標準狀態
- 13 個 SECURITY DEFINER 函式可被匿名執行 —— **這正是本專案的架構**：
  匿名不能直接寫表，一律透過這些函式，函式內自行驗證憑證與場次

必須為 false 的項目（`0002` 已處理）：

```sql
select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public' and p.proname in ('_participant_by_token','gen_pseudonym');
```

## 關閉場次

```sql
update workshops set is_open = false where join_code = 'ZL2026';
```

關閉後不再接受新投稿，已送出的資料保留。
