-- =====================================================================
-- 0004 — 造訪人次
--
-- 刻意只存「每日彙總計數」，不建立任何訪客識別列：
-- 沒有 IP、沒有 user agent、沒有瀏覽器指紋、沒有每人一列的紀錄。
-- 「不重複訪客」由瀏覽器端自己判斷（localStorage 旗標），
-- 第一次造訪才把 p_new=true 傳上來；伺服器只是加一，無從回推是誰。
-- =====================================================================

create table if not exists site_stats (
  day           date   primary key,
  visits        bigint not null default 0,
  new_visitors  bigint not null default 0
);

comment on table site_stats is
  '每日造訪彙總。僅計數，不含任何訪客識別資訊。';

alter table site_stats enable row level security;
-- 不建立任何 policy：一律透過下方 RPC 存取

-- 記錄一次造訪並回傳統計。p_new=true 代表這個瀏覽器第一次來。
create or replace function record_visit(p_new boolean default false)
returns table (total_visits bigint, total_visitors bigint, today_visits bigint)
language plpgsql volatile security definer set search_path = public as $$
declare d date := (now() at time zone 'Asia/Taipei')::date;   -- 以台灣時間分日
begin
  insert into site_stats (day, visits, new_visitors)
  values (d, 1, case when p_new then 1 else 0 end)
  on conflict (day) do update
    set visits       = site_stats.visits + 1,
        new_visitors = site_stats.new_visitors + case when p_new then 1 else 0 end;

  return query
    select coalesce(sum(s.visits), 0)::bigint,
           coalesce(sum(s.new_visitors), 0)::bigint,
           coalesce(max(s.visits) filter (where s.day = d), 0)::bigint
    from site_stats s;
end $$;

-- 只讀版本，不累加（給不想計入自己的情況用）
create or replace function get_visit_stats()
returns table (total_visits bigint, total_visitors bigint, today_visits bigint)
language sql stable security definer set search_path = public as $$
  select coalesce(sum(visits), 0)::bigint,
         coalesce(sum(new_visitors), 0)::bigint,
         coalesce(max(visits) filter (where day = (now() at time zone 'Asia/Taipei')::date), 0)::bigint
  from site_stats;
$$;

revoke all on site_stats from public, anon, authenticated;
grant execute on function record_visit(boolean) to anon, authenticated;
grant execute on function get_visit_stats()     to anon, authenticated;
