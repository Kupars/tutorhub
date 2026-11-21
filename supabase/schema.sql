-- 优师家教（TutorHub）Supabase 生产级数据库结构与安全策略（RLS）
-- 未来微信小程序可直接复用同一套表结构与 API

-- 1. 用户基础资料（区分 teacher 与 admin 角色）
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text not null default '',
  role text not null default 'teacher' check (role in ('teacher', 'admin')),
  phone text default '',
  wechat text default '',
  home_location_name text default '',
  home_lat double precision,
  home_lng double precision,
  created_at timestamptz default now()
);

-- 2. 老师简历模板表
create table if not exists public.resumes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text default '',
  gender text default '',
  school text default '',
  major text default '',
  grade_level text default '',
  subjects text[] default '{}',
  target_grades text[] default '{}',
  highlights text default '',
  experience text default '',
  teaching_style text default '',
  available_time text default '',
  expected_rate integer default 120,
  auto_apply_enabled boolean default false,
  auto_apply_rules jsonb default '{"subjects":[],"maxCommuteMin":45,"minRate":100}'::jsonb,
  updated_at timestamptz default now()
);

-- 3. 家教招募订单表
create table if not exists public.tutoring_orders (
  id text primary key,
  title text not null,
  subject text not null,
  grade text not null,
  mode text not null default '上门' check (mode in ('上门', '线上', '均可')),
  district text default '',
  address text default '',
  lat double precision,
  lng double precision,
  hourly_rate integer not null default 120,
  hours_per_session numeric(4,1) default 2,
  sessions_per_week integer default 2,
  schedule text default '',
  gender_pref text default '不限',
  student_info text default '',
  requirements text default '',
  tags text[] default '{}',
  status text not null default '招募中' check (status in ('招募中', '试讲中', '已匹配', '已结束')),
  urgent boolean default false,
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 4. 老师投递与接单记录表
create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  order_id text not null references public.tutoring_orders(id) on delete cascade,
  teacher_id uuid not null references auth.users(id) on delete cascade,
  pitch text default '',
  resume_snapshot jsonb not null default '{}'::jsonb,
  status text not null default '已投递' check (status in ('已投递', '已推荐家长', '试讲中', '已录用', '未通过', '已撤回')),
  teacher_note text default '',
  is_auto boolean default false,
  created_at timestamptz default now(),
  unique(order_id, teacher_id)
);

-- 5. 站点实时配置表（支持后台与 AI 实时修改站点标题、公告、主题）
create table if not exists public.site_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

-- 开启行级安全策略（RLS）
alter table public.profiles enable row level security;
alter table public.resumes enable row level security;
alter table public.tutoring_orders enable row level security;
alter table public.applications enable row level security;
alter table public.site_settings enable row level security;

-- 辅助函数：判断当前登录用户是否为管理员
create or replace function public.is_admin()
returns boolean language sql security definer as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- profiles 策略
create policy "用户可查看自己资料，管理员可查看全部" on public.profiles
  for select using (auth.uid() = id or public.is_admin());
create policy "用户可插入与更新自己资料" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- resumes 策略
create policy "老师管理自己的简历，管理员可读" on public.resumes
  for select using (auth.uid() = user_id or public.is_admin());
create policy "老师更新自己的简历" on public.resumes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- tutoring_orders 策略（公开可读，仅管理员可增删改）
create policy "所有人可浏览家教单" on public.tutoring_orders
  for select using (true);
create policy "仅管理员可管理家教单" on public.tutoring_orders
  for all using (public.is_admin()) with check (public.is_admin());

-- applications 策略
create policy "老师看自己投递，管理员看全部" on public.applications
  for select using (auth.uid() = teacher_id or public.is_admin());
create policy "老师可投递并修改备注或撤回" on public.applications
  for insert with check (auth.uid() = teacher_id);
create policy "老师或管理员可更新投递状态" on public.applications
  for update using (auth.uid() = teacher_id or public.is_admin());

-- site_settings 策略（公开可读，仅管理员可改）
create policy "所有人可读站点配置" on public.site_settings
  for select using (true);
create policy "仅管理员可改站点配置" on public.site_settings
  for all using (public.is_admin()) with check (public.is_admin());
