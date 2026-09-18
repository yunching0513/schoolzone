-- =====================================================================
-- 打造夢想街道 · 兒童獨立移動性（CIM）公民科學平台
-- 0001 — 核心資料模型
--
-- 設計原則
--   1. 兒童不需要帳號、不留真實姓名 —— 以「工作坊代碼 + 匿名代號」參與。
--   2. 所有寫入經 SECURITY DEFINER RPC（見 0002），資料表本身不開放直寫。
--   3. 標註記錄的是「地點」，不是「兒童的行蹤」；不儲存住家位置。
--   4. 客觀基線（schools）與主觀經驗（annotations / routes）可在 SQL 直接 join，
--      這就是研究的核心分析單元。
-- =====================================================================

create extension if not exists postgis;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- enums
do $$ begin
  create type participant_role  as enum ('student','parent','teacher','resident','researcher');
  create type workshop_mode     as enum ('onsite','online','hybrid','open');
  create type annot_valence     as enum ('negative','positive','idea');
  create type travel_mode       as enum ('walk','bike','scooter_pax','car','bus','metro','mixed');
  create type accompaniment     as enum ('alone','with_peers','with_sibling','with_adult','driven');
  create type survey_wave       as enum ('pre','post','followup');
  create type moderation_status as enum ('pending','published','hidden','flagged');
  create type consent_kind      as enum ('child_assent','guardian_consent','adult_consent');
exception when duplicate_object then null; end $$;

-- =====================================================================
-- 1. 學校（客觀基線）—— 由 data/school_zones.geojson 匯入
-- =====================================================================
create table if not exists schools (
  code          text primary key,              -- md5(name|lon|lat) 前 10 碼，跨次匯入穩定
  name          text        not null,
  level         text        not null,          -- elementary / junior / senior / tertiary / special / other
  county_slug   text,                          -- taipei / chiayi / ...
  county_zh     text,
  data_ym       text,                          -- 國土測繪中心資料年月
  lon           double precision not null,
  lat           double precision not null,
  geom          geography(Point,4326)
                generated always as (st_setsrid(st_makepoint(lon, lat), 4326)::geography) stored,
  -- 以下為平台既有的客觀步行環境指標（school_walkshed.json）
  deficit_score int,                           -- 0–100，越高越差
  deficit_grade text,                          -- severe / high / moderate / low
  connectivity  double precision,              -- 可達人行道 ÷ 直線範圍內人行道
  reach_km      double precision,              -- 15 分鐘沿人行道可達長度
  no_sidewalk   boolean default false,         -- 完全走不到連通人行道
  created_at    timestamptz not null default now()
);
create index if not exists schools_geom_idx   on schools using gist (geom);
create index if not exists schools_county_idx on schools (county_slug);
create index if not exists schools_grade_idx  on schools (deficit_grade);

comment on table  schools is '4,336 所全國學校與其客觀步行環境基線指標';
comment on column schools.connectivity is '連通率；國小中位數 0.019（2026-06 人行道路網）';

-- =====================================================================
-- 2. 工作坊場次
-- =====================================================================
create table if not exists workshops (
  id            uuid primary key default gen_random_uuid(),
  school_code   text references schools(code) on delete set null,
  title         text not null,
  mode          workshop_mode not null default 'onsite',
  join_code     text not null unique,          -- 現場發給參與者的短代碼，如 'AB12CD'
  facilitator   text,                          -- 主持人（研究者姓名，非兒童）
  starts_at     timestamptz,
  ends_at       timestamptz,
  is_open       boolean not null default true, -- 關閉後不再接受新標註
  -- 研究倫理欄位
  irb_ref       text,                          -- IRB 核准文號
  consent_ver   text,                          -- 同意書版本
  notes         text,
  created_at    timestamptz not null default now()
);
create index if not exists workshops_school_idx on workshops (school_code);
create index if not exists workshops_open_idx   on workshops (is_open) where is_open;

-- =====================================================================
-- 3. 參與者（化名；兒童不留任何可識別資訊）
-- =====================================================================
create table if not exists participants (
  id              uuid primary key default gen_random_uuid(),
  workshop_id     uuid not null references workshops(id) on delete cascade,
  role            participant_role not null,
  pseudonym       text not null,               -- 自動產生，如「綠繡眼-3F2A」
  -- 僅收集分析必要的粗分類；一律可為 null
  age_band        text,                        -- '6-8','9-11','12-14','15-17','18-64','65+'
  grade_year      int,                         -- 學生年級 1–12
  gender          text,                        -- 自由填答／可不填
  home_distance_band text,                     -- '<300m','300-800m','800m-2km','>2km' —— 不存住家座標
  -- 授權狀態
  consent_status  consent_kind,
  consent_at      timestamptz,
  -- 裝置綁定：只存雜湊，用於同一裝置續填，不可回推
  device_hash     text,
  token           uuid not null default gen_random_uuid() unique,  -- 客戶端持有的寫入憑證（非主鍵）
  points          int not null default 0,      -- 遊戲化累積點數
  created_at      timestamptz not null default now(),
  unique (workshop_id, pseudonym)
);
create index if not exists participants_ws_idx     on participants (workshop_id);
create index if not exists participants_device_idx on participants (device_hash);

comment on table participants is
  '化名參與者。禁止寫入姓名、學號、email、住家座標；兒童資料僅保留年齡組與年級。';

-- =====================================================================
-- 4. 同意紀錄（與 participants 分開，供稽核）
-- =====================================================================
create table if not exists consent_records (
  id             uuid primary key default gen_random_uuid(),
  participant_id uuid not null references participants(id) on delete cascade,
  kind           consent_kind not null,
  granted        boolean not null,
  document_ver   text,
  guardian_pseudonym text,                     -- 家長化名，非真名
  granted_at     timestamptz not null default now()
);
create index if not exists consent_participant_idx on consent_records (participant_id);

-- =====================================================================
-- 5. 標註語彙（可供性分類）
-- =====================================================================
create table if not exists annotation_kinds (
  key        text primary key,
  valence    annot_valence not null,
  label_zh   text not null,                    -- 兒童聽得懂的話，不是工程術語
  label_en   text not null,
  icon       text,
  sort_order int not null default 0,
  -- 對應的客觀工程指標（供後續比對「主觀 vs 客觀」）
  objective_field text
);

-- =====================================================================
-- 6. 標註點（PPGIS 核心）
-- =====================================================================
create table if not exists annotations (
  id             uuid primary key default gen_random_uuid(),
  workshop_id    uuid not null references workshops(id) on delete cascade,
  participant_id uuid references participants(id) on delete set null,
  school_code    text references schools(code) on delete set null,
  kind           text not null references annotation_kinds(key),
  lon            double precision not null,
  lat            double precision not null,
  geom           geography(Point,4326)
                 generated always as (st_setsrid(st_makepoint(lon, lat), 4326)::geography) stored,
  severity       int check (severity between 1 and 5),   -- 負向：多嚴重；正向：多喜歡
  body           text,                                    -- 自由敘述
  -- 街景連動（沿用既有相簿機制）
  pano_id        text,
  heading        int,
  image_url      text,
  road_name      text,
  -- 距校距離（寫入時算好，方便分析）
  dist_to_school_m double precision,
  status         moderation_status not null default 'pending',
  created_at     timestamptz not null default now()
);
create index if not exists annotations_geom_idx   on annotations using gist (geom);
create index if not exists annotations_ws_idx     on annotations (workshop_id);
create index if not exists annotations_school_idx on annotations (school_code);
create index if not exists annotations_kind_idx   on annotations (kind);
create index if not exists annotations_pub_idx    on annotations (status) where status = 'published';

-- =====================================================================
-- 7. 通學路徑（CIM 的核心測量）
-- =====================================================================
create table if not exists routes (
  id             uuid primary key default gen_random_uuid(),
  workshop_id    uuid not null references workshops(id) on delete cascade,
  participant_id uuid references participants(id) on delete set null,
  school_code    text references schools(code) on delete set null,
  geom           geography(LineString,4326) not null,
  direction      text check (direction in ('to_school','from_school','both')),
  mode           travel_mode not null,
  accompany      accompaniment not null,        -- ★ 獨立性的直接測量
  duration_min   int,
  frequency      text,                          -- 'daily','most_days','sometimes','rarely'
  -- 衍生欄位（RPC 寫入時計算）
  length_m       double precision,
  status         moderation_status not null default 'pending',
  created_at     timestamptz not null default now()
);
create index if not exists routes_geom_idx   on routes using gist (geom);
create index if not exists routes_ws_idx     on routes (workshop_id);
create index if not exists routes_school_idx on routes (school_code);

comment on column routes.accompany is
  'CIM 操作化的關鍵欄位：alone / with_peers 視為獨立移動，with_adult / driven 則否。';
comment on column routes.geom is
  '路徑起點應為學校端；為保護隱私，客戶端在送出前會裁掉住家端最後 150 公尺。';

-- =====================================================================
-- 8. 獨立移動授權量表（Hillman et al. 1990 六項 licences）
-- =====================================================================
create table if not exists licences (
  key        text primary key,
  label_zh   text not null,
  label_en   text not null,
  sort_order int not null default 0
);

create table if not exists licence_responses (
  id             uuid primary key default gen_random_uuid(),
  workshop_id    uuid not null references workshops(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  wave           survey_wave not null default 'pre',
  licence_key    text not null references licences(key),
  allowed        boolean,                       -- 目前是否被允許
  age_expected   int,                           -- 家長認為幾歲才可以
  respondent     participant_role not null,     -- student 自陳 or parent 代答
  created_at     timestamptz not null default now(),
  unique (participant_id, wave, licence_key, respondent)
);
create index if not exists licence_resp_ws_idx on licence_responses (workshop_id, wave);

-- =====================================================================
-- 9. 遊戲化
-- =====================================================================
create table if not exists missions (
  id           uuid primary key default gen_random_uuid(),
  workshop_id  uuid references workshops(id) on delete cascade,  -- null = 全平台任務
  title_zh     text not null,
  title_en     text,
  description  text,
  kind         text not null,                  -- 'annotate_n','route','photo','licence_survey'
  target_count int not null default 1,
  points       int not null default 10,
  badge_key    text,
  active       boolean not null default true
);

create table if not exists badges (
  key      text primary key,
  name_zh  text not null,
  name_en  text,
  icon     text,
  criteria text
);

create table if not exists mission_completions (
  id             uuid primary key default gen_random_uuid(),
  mission_id     uuid not null references missions(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  completed_at   timestamptz not null default now(),
  unique (mission_id, participant_id)
);

-- =====================================================================
-- 10. 街道改造相簿 + AI 改造結果（Tier-3：Before / After 閉環）
-- =====================================================================
create table if not exists album_items (
  id             uuid primary key default gen_random_uuid(),
  workshop_id    uuid references workshops(id) on delete set null,
  participant_id uuid references participants(id) on delete set null,
  annotation_id  uuid references annotations(id) on delete set null,
  school_code    text references schools(code) on delete set null,
  lon            double precision not null,
  lat            double precision not null,
  heading        int,
  pitch          int default 0,
  pano_id        text,
  road_name      text,
  county_zh      text,
  note           text,
  before_url     text,
  status         moderation_status not null default 'pending',
  created_at     timestamptz not null default now()
);
create index if not exists album_ws_idx on album_items (workshop_id);

create table if not exists remakes (
  id            uuid primary key default gen_random_uuid(),
  album_item_id uuid not null references album_items(id) on delete cascade,
  after_url     text not null,
  prompt        text,
  model         text,
  resolution    text,
  created_at    timestamptz not null default now()
);
create index if not exists remakes_item_idx on remakes (album_item_id);
