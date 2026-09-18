-- =====================================================================
-- 0002 — 權限模型與寫入 API
--
-- 安全模型
--   · 所有資料表一律開啟 RLS，預設拒絕。
--   · 匿名使用者「不能直接 INSERT 任何表」，只能呼叫下列 SECURITY DEFINER 函式；
--     函式會驗證工作坊代碼 / 參與者憑證、檢查場次是否開放、並做投稿頻率上限。
--   · 匿名使用者只讀得到 status='published' 的內容，且讀不到 participants。
--   · 研究者（登入帳號且列於 researchers 表）才讀得到原始資料與個體層級欄位。
-- =====================================================================

-- --------------------------------------------------------- 研究者名單
create table if not exists researchers (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  name     text,
  added_at timestamptz not null default now()
);

create or replace function is_researcher() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from researchers r where r.user_id = auth.uid());
$$;

-- --------------------------------------------------------------- RLS
alter table schools            enable row level security;
alter table workshops          enable row level security;
alter table participants       enable row level security;
alter table consent_records    enable row level security;
alter table annotation_kinds   enable row level security;
alter table annotations        enable row level security;
alter table routes             enable row level security;
alter table licences           enable row level security;
alter table licence_responses  enable row level security;
alter table missions           enable row level security;
alter table badges             enable row level security;
alter table mission_completions enable row level security;
alter table album_items        enable row level security;
alter table remakes            enable row level security;
alter table researchers        enable row level security;

-- 公開可讀的參考資料
drop policy if exists p_schools_read on schools;
create policy p_schools_read on schools for select to anon, authenticated using (true);

drop policy if exists p_kinds_read on annotation_kinds;
create policy p_kinds_read on annotation_kinds for select to anon, authenticated using (true);

drop policy if exists p_licences_read on licences;
create policy p_licences_read on licences for select to anon, authenticated using (true);

drop policy if exists p_badges_read on badges;
create policy p_badges_read on badges for select to anon, authenticated using (true);

-- 工作坊：只露出開放中的場次，且不含 irb_ref / notes（由 view 控制欄位）
drop policy if exists p_ws_read on workshops;
create policy p_ws_read on workshops for select to anon, authenticated
  using (is_open or is_researcher());

-- 標註 / 路徑 / 相簿：匿名只看得到已審核發布的
drop policy if exists p_annot_read on annotations;
create policy p_annot_read on annotations for select to anon, authenticated
  using (status = 'published' or is_researcher());

drop policy if exists p_routes_read on routes;
create policy p_routes_read on routes for select to anon, authenticated
  using (status = 'published' or is_researcher());

drop policy if exists p_album_read on album_items;
create policy p_album_read on album_items for select to anon, authenticated
  using (status = 'published' or is_researcher());

drop policy if exists p_remakes_read on remakes;
create policy p_remakes_read on remakes for select to anon, authenticated
  using (exists (select 1 from album_items a
                 where a.id = remakes.album_item_id
                   and (a.status = 'published' or is_researcher())));

drop policy if exists p_missions_read on missions;
create policy p_missions_read on missions for select to anon, authenticated using (active or is_researcher());

-- 個資表：只有研究者讀得到
drop policy if exists p_participants_read on participants;
create policy p_participants_read on participants for select to authenticated using (is_researcher());

drop policy if exists p_consent_read on consent_records;
create policy p_consent_read on consent_records for select to authenticated using (is_researcher());

drop policy if exists p_licresp_read on licence_responses;
create policy p_licresp_read on licence_responses for select to authenticated using (is_researcher());

drop policy if exists p_missioncomp_read on mission_completions;
create policy p_missioncomp_read on mission_completions for select to authenticated using (is_researcher());

drop policy if exists p_researchers_read on researchers;
create policy p_researchers_read on researchers for select to authenticated using (user_id = auth.uid());

-- 研究者可審核（改 status）
drop policy if exists p_annot_moderate on annotations;
create policy p_annot_moderate on annotations for update to authenticated
  using (is_researcher()) with check (is_researcher());
drop policy if exists p_routes_moderate on routes;
create policy p_routes_moderate on routes for update to authenticated
  using (is_researcher()) with check (is_researcher());
drop policy if exists p_album_moderate on album_items;
create policy p_album_moderate on album_items for update to authenticated
  using (is_researcher()) with check (is_researcher());

-- 沒有任何 INSERT policy → 匿名一律走下方 RPC。

-- =====================================================================
-- 寫入 API（SECURITY DEFINER）
-- =====================================================================

-- 依座標找最近的學校
create or replace function nearest_school(p_lat double precision, p_lon double precision)
returns table (code text, name text, level text, county_zh text, dist_m double precision)
language sql stable security definer set search_path = public as $$
  select s.code, s.name, s.level, s.county_zh,
         st_distance(s.geom, st_setsrid(st_makepoint(p_lon, p_lat),4326)::geography)
  from schools s
  order by s.geom <-> st_setsrid(st_makepoint(p_lon, p_lat),4326)::geography
  limit 1;
$$;

-- 產生兒童友善的化名：「生物名-4碼」
create or replace function gen_pseudonym() returns text
language sql volatile set search_path = public as $$
  select (array['綠繡眼','石虎','穿山甲','黑冠麻鷺','台灣藍鵲','梅花鹿','白鼻心','彈塗魚',
                '諸羅樹蛙','領角鴞','食蟹獴','山羌','八色鳥','黑面琵鷺','紫斑蝶','招潮蟹'])
         [1 + floor(random()*16)::int]
         || '-' || upper(substr(md5(random()::text), 1, 4));
$$;

-- 加入工作坊 → 取得參與者憑證
create or replace function join_workshop(
  p_join_code  text,
  p_role       participant_role,
  p_device_hash text default null,
  p_age_band   text default null,
  p_grade_year int  default null,
  p_home_band  text default null
) returns table (token uuid, pseudonym text, workshop_id uuid, workshop_title text,
                 school_code text, school_name text)
language plpgsql volatile security definer set search_path = public as $$
declare v_ws workshops%rowtype; v_p participants%rowtype; v_name text;
begin
  select * into v_ws from workshops w where upper(w.join_code) = upper(p_join_code);
  if not found then raise exception 'workshop_not_found' using errcode='P0002'; end if;
  if not v_ws.is_open then raise exception 'workshop_closed' using errcode='P0001'; end if;

  -- 同一裝置重複加入同一場次 → 沿用原憑證，不重複建檔
  if p_device_hash is not null then
    select * into v_p from participants p
     where p.workshop_id = v_ws.id and p.device_hash = p_device_hash limit 1;
  end if;

  if v_p.id is null then
    insert into participants (workshop_id, role, pseudonym, age_band, grade_year,
                              home_distance_band, device_hash)
    values (v_ws.id, p_role, gen_pseudonym(), p_age_band, p_grade_year,
            p_home_band, p_device_hash)
    returning * into v_p;
  end if;

  select s.name into v_name from schools s where s.code = v_ws.school_code;
  return query select v_p.token, v_p.pseudonym, v_ws.id, v_ws.title,
                      v_ws.school_code, v_name;
end $$;

-- 內部：憑證 → 參與者（並檢查場次仍開放）
create or replace function _participant_by_token(p_token uuid)
returns participants language plpgsql stable security definer set search_path = public as $$
declare v_p participants%rowtype; v_open boolean;
begin
  select * into v_p from participants p where p.token = p_token;
  if not found then raise exception 'invalid_token' using errcode='28000'; end if;
  select w.is_open into v_open from workshops w where w.id = v_p.workshop_id;
  if not coalesce(v_open, false) then raise exception 'workshop_closed' using errcode='P0001'; end if;
  return v_p;
end $$;

-- 送出一則標註
create or replace function submit_annotation(
  p_token     uuid,
  p_kind      text,
  p_lat       double precision,
  p_lon       double precision,
  p_severity  int  default null,
  p_body      text default null,
  p_pano_id   text default null,
  p_heading   int  default null,
  p_image_url text default null,
  p_road_name text default null
) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare v_p participants%rowtype; v_school text; v_dist double precision;
        v_count int; v_id uuid;
begin
  v_p := _participant_by_token(p_token);

  -- 投稿上限：每位參與者每場 200 則、每分鐘 10 則
  select count(*) into v_count from annotations a where a.participant_id = v_p.id;
  if v_count >= 200 then raise exception 'quota_exceeded' using errcode='P0003'; end if;
  select count(*) into v_count from annotations a
   where a.participant_id = v_p.id and a.created_at > now() - interval '1 minute';
  if v_count >= 10 then raise exception 'rate_limited' using errcode='P0004'; end if;

  if p_lat is null or p_lon is null
     or p_lat not between 21.5 and 26.5 or p_lon not between 118.0 and 122.5 then
    raise exception 'out_of_bounds' using errcode='22003';
  end if;
  if length(coalesce(p_body,'')) > 2000 then raise exception 'body_too_long'; end if;

  select ns.code, ns.dist_m into v_school, v_dist from nearest_school(p_lat, p_lon) ns;

  insert into annotations (workshop_id, participant_id, school_code, kind, lon, lat,
                           severity, body, pano_id, heading, image_url, road_name,
                           dist_to_school_m)
  values (v_p.workshop_id, v_p.id, v_school, p_kind, p_lon, p_lat,
          p_severity, nullif(trim(p_body),''), p_pano_id, p_heading, p_image_url,
          p_road_name, v_dist)
  returning id into v_id;

  update participants set points = points + 5 where id = v_p.id;
  return v_id;
end $$;

-- 送出一條通學路徑（座標為 [[lon,lat],…]）
create or replace function submit_route(
  p_token     uuid,
  p_coords    jsonb,
  p_mode      travel_mode,
  p_accompany accompaniment,
  p_direction text default 'to_school',
  p_duration  int  default null,
  p_frequency text default null
) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare v_p participants%rowtype; v_line geography; v_school text; v_id uuid; v_n int;
begin
  v_p := _participant_by_token(p_token);
  v_n := jsonb_array_length(p_coords);
  if v_n is null or v_n < 2 then raise exception 'need_two_points'; end if;
  if v_n > 500 then raise exception 'too_many_points'; end if;

  select st_makeline(array_agg(
           st_setsrid(st_makepoint((c->>0)::double precision, (c->>1)::double precision), 4326)
           order by ord))::geography
    into v_line
    from jsonb_array_elements(p_coords) with ordinality t(c, ord);

  select ns.code into v_school
    from nearest_school((p_coords->0->>1)::double precision,
                        (p_coords->0->>0)::double precision) ns;

  insert into routes (workshop_id, participant_id, school_code, geom, direction, mode,
                      accompany, duration_min, frequency, length_m)
  values (v_p.workshop_id, v_p.id, v_school, v_line, p_direction, p_mode,
          p_accompany, p_duration, p_frequency, st_length(v_line))
  returning id into v_id;

  update participants set points = points + 20 where id = v_p.id;
  return v_id;
end $$;

-- 送出獨立移動授權量表（p_items: [{"key":"cross_road","allowed":true,"age_expected":9}, …]）
create or replace function submit_licences(
  p_token  uuid,
  p_wave   survey_wave,
  p_items  jsonb
) returns int
language plpgsql volatile security definer set search_path = public as $$
declare v_p participants%rowtype; v_n int := 0; it jsonb;
begin
  v_p := _participant_by_token(p_token);
  for it in select * from jsonb_array_elements(p_items) loop
    insert into licence_responses (workshop_id, participant_id, wave, licence_key,
                                   allowed, age_expected, respondent)
    values (v_p.workshop_id, v_p.id, p_wave, it->>'key',
            (it->>'allowed')::boolean, nullif(it->>'age_expected','')::int, v_p.role)
    on conflict (participant_id, wave, licence_key, respondent) do update
      set allowed = excluded.allowed, age_expected = excluded.age_expected;
    v_n := v_n + 1;
  end loop;
  update participants set points = points + 15 where id = v_p.id;
  return v_n;
end $$;

-- 記錄同意
create or replace function record_consent(
  p_token uuid, p_kind consent_kind, p_granted boolean,
  p_document_ver text default null, p_guardian_pseudonym text default null
) returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_p participants%rowtype;
begin
  v_p := _participant_by_token(p_token);
  insert into consent_records (participant_id, kind, granted, document_ver, guardian_pseudonym)
  values (v_p.id, p_kind, p_granted, p_document_ver, p_guardian_pseudonym);
  update participants set consent_status = p_kind, consent_at = now()
   where id = v_p.id and p_granted;
end $$;

-- 相簿收藏 + AI 改造結果回寫
create or replace function save_album_item(
  p_token uuid, p_lat double precision, p_lon double precision,
  p_heading int default null, p_pitch int default 0, p_pano_id text default null,
  p_road_name text default null, p_county_zh text default null,
  p_note text default null, p_before_url text default null,
  p_annotation_id uuid default null
) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare v_p participants%rowtype; v_school text; v_id uuid;
begin
  v_p := _participant_by_token(p_token);
  select ns.code into v_school from nearest_school(p_lat, p_lon) ns;
  insert into album_items (workshop_id, participant_id, annotation_id, school_code,
                           lon, lat, heading, pitch, pano_id, road_name, county_zh,
                           note, before_url)
  values (v_p.workshop_id, v_p.id, p_annotation_id, v_school,
          p_lon, p_lat, p_heading, p_pitch, p_pano_id, p_road_name, p_county_zh,
          nullif(trim(p_note),''), p_before_url)
  returning id into v_id;
  return v_id;
end $$;

create or replace function save_remake(
  p_token uuid, p_album_item_id uuid, p_after_url text,
  p_prompt text default null, p_model text default null, p_resolution text default null
) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare v_p participants%rowtype; v_id uuid;
begin
  v_p := _participant_by_token(p_token);
  if not exists (select 1 from album_items a
                  where a.id = p_album_item_id and a.workshop_id = v_p.workshop_id) then
    raise exception 'album_item_not_in_workshop';
  end if;
  insert into remakes (album_item_id, after_url, prompt, model, resolution)
  values (p_album_item_id, p_after_url, p_prompt, p_model, p_resolution)
  returning id into v_id;
  update participants set points = points + 10 where id = v_p.id;
  return v_id;
end $$;

-- ------------------------------------------------------------- 授權
revoke all on all tables    in schema public from anon, authenticated;
grant  select on schools, annotation_kinds, licences, badges, workshops,
                 annotations, routes, album_items, remakes, missions
       to anon, authenticated;
grant  select on participants, consent_records, licence_responses,
                 mission_completions, researchers to authenticated;
grant  update on annotations, routes, album_items to authenticated;

revoke all on all functions in schema public from anon, authenticated;
grant execute on function nearest_school(double precision, double precision)          to anon, authenticated;
grant execute on function join_workshop(text, participant_role, text, text, int, text) to anon, authenticated;
grant execute on function submit_annotation(uuid, text, double precision, double precision,
                                            int, text, text, int, text, text)          to anon, authenticated;
grant execute on function submit_route(uuid, jsonb, travel_mode, accompaniment, text, int, text) to anon, authenticated;
grant execute on function submit_licences(uuid, survey_wave, jsonb)                    to anon, authenticated;
grant execute on function record_consent(uuid, consent_kind, boolean, text, text)      to anon, authenticated;
grant execute on function save_album_item(uuid, double precision, double precision, int, int,
                                          text, text, text, text, text, uuid)          to anon, authenticated;
grant execute on function save_remake(uuid, uuid, text, text, text, text)              to anon, authenticated;
grant execute on function is_researcher()                                              to anon, authenticated;

-- _participant_by_token / gen_pseudonym 僅供內部呼叫，不對外開放
