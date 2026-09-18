-- =====================================================================
-- 0003 — 標註語彙、量表題目、遊戲化內容、分析用檢視
-- =====================================================================

-- ------------------------------------------------- 標註語彙（可供性分類）
-- 用兒童聽得懂的話。負向 = 阻礙獨立移動；正向 = Kyttä 所謂「已實現的可供性」；
-- idea = 改造提案（接 AI 街景生成器）。
insert into annotation_kinds (key, valence, label_zh, label_en, icon, sort_order, objective_field) values
  ('scary_crossing',    'negative','這個路口我不敢過',        'Crossing I dare not use',      '😨', 10, 'crash_pedestrian'),
  ('no_sidewalk',       'negative','沒有人行道，要走馬路',    'No sidewalk — I walk on the road','🚧',20,'no_sidewalk'),
  ('blocked_sidewalk',  'negative','人行道被擋住',            'Sidewalk blocked',             '🚗', 30, 'clear_width'),
  ('scooter_on_walk',   'negative','機車騎上人行道',          'Scooters on the sidewalk',     '🛵', 40, 'clear_width'),
  ('fast_traffic',      'negative','車開很快',                'Traffic is fast',              '💨', 50, 'road_hierarchy'),
  ('bad_visibility',    'negative','看不到來車',              'Cannot see oncoming traffic',  '🙈', 60, null),
  ('dark_at_night',     'negative','天黑很暗',                'Dark after sunset',            '🌑', 70, null),
  ('flooding',          'negative','下雨會積水',              'Floods when it rains',         '🌧', 80, null),
  ('step_or_slope',     'negative','有階梯／斜坡過不去',      'Step or slope I cannot pass',  '♿', 90, 'curb_ramp'),
  ('makes_me_uneasy',   'negative','這裡讓我不安',            'This place makes me uneasy',   '😟',100, null),
  ('safe_crossing',     'positive','這裡過馬路很安心',        'A crossing that feels safe',   '🟢',110, null),
  ('fun_place',         'positive','這裡很好玩，想停下來',    'Fun — I want to stop here',    '🛝',120, null),
  ('friendly_eyes',     'positive','有大人會看著我',          'Adults keep an eye out here',  '👀',130, null),
  ('shade_green',       'positive','有樹蔭很舒服',            'Shady and pleasant',           '🌳',140, null),
  ('meet_friends',      'positive','會遇到同學',              'I meet friends here',          '🧑‍🤝‍🧑',150, null),
  ('my_shortcut',       'positive','我的祕密捷徑',            'My shortcut',                  '🧭',160, null),
  ('idea',              'idea',    '我想把這裡改成…',         'I would change this into…',    '💡',170, null)
on conflict (key) do update set
  valence = excluded.valence, label_zh = excluded.label_zh,
  label_en = excluded.label_en, icon = excluded.icon, sort_order = excluded.sort_order;

-- ------------------------------- 獨立移動授權六項（Hillman et al., 1990）
insert into licences (key, label_zh, label_en, sort_order) values
  ('cross_road',      '可以自己過馬路',              'Cross roads alone',                 10),
  ('travel_to_school','可以自己上下學',              'Travel to school alone',            20),
  ('travel_elsewhere','可以自己去學校以外的地方',    'Travel to places other than school', 30),
  ('cycle_on_road',   '可以自己騎腳踏車上路',        'Cycle on roads alone',              40),
  ('use_transit',     '可以自己搭公車或捷運',        'Use buses / metro alone',           50),
  ('out_after_dark',  '天黑後可以自己外出',          'Go out alone after dark',           60)
on conflict (key) do update set label_zh = excluded.label_zh, label_en = excluded.label_en;

-- --------------------------------------------------------------- 徽章
insert into badges (key, name_zh, name_en, icon, criteria) values
  ('first_mark',  '第一個標記',   'First Mark',      '📍','送出第一則標註'),
  ('road_scout',  '街道偵察員',   'Street Scout',    '🔍','累積 10 則標註'),
  ('route_drawer','通學路繪圖員', 'Route Cartographer','🗺','畫出自己的通學路徑'),
  ('both_sides',  '看見好與壞',   'Both Sides',      '⚖️','正向與負向標註各 3 則以上'),
  ('dreamer',     '夢想街道設計師','Dream Designer', '🎨','完成一次 AI 街道改造')
on conflict (key) do nothing;

-- =====================================================================
-- 分析用檢視
-- =====================================================================

-- 公開地圖圖層：已發布標註（不含參與者身分）
create or replace view v_annotations_public
with (security_invoker = true) as
select a.id, a.lon, a.lat, a.kind, k.valence, k.label_zh, k.label_en, k.icon,
       a.severity, a.body, a.image_url, a.road_name,
       a.school_code, s.name as school_name, a.dist_to_school_m,
       a.created_at
from annotations a
join annotation_kinds k on k.key = a.kind
left join schools s on s.code = a.school_code
where a.status = 'published';

-- ★ 研究核心：客觀基線 vs 主觀感受（每校一列）
create or replace view v_school_objective_vs_perceived
with (security_invoker = true) as
select s.code, s.name, s.level, s.county_zh,
       -- 客觀（平台既有計算）
       s.deficit_score, s.deficit_grade, s.connectivity, s.reach_km, s.no_sidewalk,
       -- 主觀（群眾標註）
       count(*) filter (where k.valence = 'negative')                     as neg_marks,
       count(*) filter (where k.valence = 'positive')                     as pos_marks,
       count(*) filter (where k.valence = 'idea')                         as idea_marks,
       avg(a.severity) filter (where k.valence = 'negative')              as mean_severity,
       -- 落差指標：負向標註佔比（0–1），可與 deficit_score/100 相關分析
       case when count(a.id) = 0 then null
            else count(*) filter (where k.valence = 'negative')::numeric
                 / nullif(count(a.id), 0) end                             as neg_share,
       count(distinct a.participant_id)                                   as n_contributors
from schools s
left join annotations a on a.school_code = s.code and a.status = 'published'
left join annotation_kinds k on k.key = a.kind
group by s.code, s.name, s.level, s.county_zh, s.deficit_score, s.deficit_grade,
         s.connectivity, s.reach_km, s.no_sidewalk;

-- ★ CIM 指標：通學路徑的獨立性
create or replace view v_route_independence
with (security_invoker = true) as
select r.workshop_id, r.school_code, s.name as school_name,
       r.mode, r.accompany,
       (r.accompany in ('alone','with_peers','with_sibling')) as is_independent,
       r.length_m, r.duration_min, r.frequency,
       p.age_band, p.grade_year, p.home_distance_band
from routes r
left join schools s on s.code = r.school_code
left join participants p on p.id = r.participant_id
where r.status = 'published';

-- ★ 授權量表彙總：前後測對照（研究者才讀得到底層資料）
create or replace view v_licence_summary
with (security_invoker = true) as
select lr.workshop_id, w.title as workshop_title, lr.wave, lr.licence_key,
       l.label_zh, lr.respondent,
       count(*)                                        as n,
       count(*) filter (where lr.allowed)              as n_allowed,
       round(100.0 * count(*) filter (where lr.allowed) / nullif(count(*),0), 1) as pct_allowed,
       avg(lr.age_expected)                            as mean_age_expected
from licence_responses lr
join licences l  on l.key = lr.licence_key
join workshops w on w.id  = lr.workshop_id
group by lr.workshop_id, w.title, lr.wave, lr.licence_key, l.label_zh, lr.respondent, l.sort_order
order by l.sort_order;

-- 工作坊儀表板（給主持人看現場進度）
create or replace view v_workshop_progress
with (security_invoker = true) as
select w.id, w.title, w.join_code, w.is_open, w.starts_at,
       s.name as school_name,
       count(distinct p.id)                                   as n_participants,
       count(distinct a.id) filter (where a.id is not null)    as n_annotations,
       count(distinct r.id) filter (where r.id is not null)    as n_routes,
       count(distinct a.id) filter (where a.status = 'pending') as n_pending
from workshops w
left join schools s      on s.code = w.school_code
left join participants p on p.workshop_id = w.id
left join annotations a  on a.workshop_id = w.id
left join routes r       on r.workshop_id = w.id
group by w.id, w.title, w.join_code, w.is_open, w.starts_at, s.name;

grant select on v_annotations_public, v_school_objective_vs_perceived to anon, authenticated;
grant select on v_route_independence, v_licence_summary, v_workshop_progress to authenticated;
