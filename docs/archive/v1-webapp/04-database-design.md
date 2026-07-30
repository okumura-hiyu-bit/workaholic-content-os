# 4. データベース設計

PostgreSQL（Supabase）。全テーブルに `organization_id` を持たせ、RLSで境界を強制する（`id` はすべて `uuid`、`created_at`/`updated_at` は省略表記だが全テーブルに付与する前提）。

## 4.1 ER概要

```
organizations 1─* memberships *─1 users
organizations 1─* channels
organizations 1─* ideas ──(採用時)──> videos
organizations 1─* videos
videos 1─1 video_plans
videos 1─* scripts
videos 1─* title_options
videos 1─* thumbnail_concepts
videos 1─1 descriptions
videos 1─1 edit_instructions
videos 1─* shorts_clips
videos 1─* posts ──* channels
videos 1─* kpi_video_snapshots
channels 1─* kpi_channel_snapshots
organizations 1─* competitors
organizations 1─* inquiries ──0..1 videos
organizations 1─* tasks ──0..1 videos
organizations 1─* ai_generations ──0..1 videos
organizations 1─* reports
organizations 1─* activity_logs
```

## 4.2 テーブル定義

### organizations（ワークスペース）
```sql
id            uuid primary key
name          text not null
slug          text unique not null
type          text not null default 'internal'  -- internal | client
brand_color   text                                -- HEX
plan          text not null default 'internal'    -- Phase2で課金プラン管理に使用
created_at    timestamptz not null default now()
```

### users / memberships
```sql
-- users は Supabase Auth のユーザーとほぼ1:1（プロフィール拡張分のみ自前テーブル）
users (id uuid pk, email text, name text, avatar_url text)

memberships (
  id uuid pk,
  organization_id uuid references organizations,
  user_id uuid references users,
  role text not null  -- owner | director | editor | analyst | viewer
  unique(organization_id, user_id)
)
```

### channels（配信チャンネル）
```sql
id                 uuid primary key
organization_id    uuid references organizations
platform           text not null  -- youtube | instagram | tiktok | podcast
name               text not null
external_channel_id text
access_token_ref   text            -- Vaultへの参照キー。トークン実体はDBに平文保存しない
connected_at       timestamptz
```

### ideas（アイデア管理）
```sql
id                  uuid primary key
organization_id     uuid references organizations
title               text not null
description         text
source              text not null   -- trend | competitor | news | youtube | manual
source_ref_url      text
is_favorite         boolean not null default false
status              text not null default 'new'  -- new | reviewing | adopted | rejected
score               numeric         -- AIによる期待スコア
ai_generated        boolean not null default false
converted_video_id  uuid references videos(id)   -- 動画化された場合
created_by          uuid references users
```

### videos（中心オブジェクト）
```sql
id                    uuid primary key
organization_id       uuid references organizations
channel_id            uuid references channels
title                 text
status                text not null default 'idea'
  -- idea | planning | shooting_wait | editing | review | scheduled | published | archived
planned_shoot_date    date
planned_publish_date  date
published_at          timestamptz
thumbnail_url         text
assignee_id           uuid references users
priority              text default 'normal'   -- low | normal | high
source_idea_id        uuid references ideas(id)
created_by            uuid references users
```

### video_plans（企画：videos と 1:1）
```sql
video_id        uuid primary key references videos
concept         text
target_audience text
goal            text
questions_list  jsonb    -- 質問リスト（配列）
structure       jsonb    -- 構成案（章立て配列）
```

### scripts（台本：バージョン管理）
```sql
id           uuid primary key
video_id     uuid references videos
version      int not null
content      text not null
generated_by text not null   -- ai | human
created_by   uuid references users
```

### title_options / thumbnail_concepts
```sql
title_options (
  id uuid pk, video_id uuid references videos,
  text text not null, is_selected boolean default false,
  ai_generated boolean default false, note text
)

thumbnail_concepts (
  id uuid pk, video_id uuid references videos,
  description text not null,      -- サムネの構成案（テキスト指示）
  reference_image_url text,
  is_selected boolean default false,
  ai_generated boolean default false
)
```

### descriptions / edit_instructions（videos と 1:1）
```sql
descriptions (
  video_id uuid primary key references videos,
  youtube_description text,
  hashtags text[]
)

edit_instructions (
  video_id uuid primary key references videos,
  content text,            -- 編集指示書本文
  reference_urls text[]
)
```

### shorts_clips（切り抜き提案）
```sql
id            uuid primary key
video_id      uuid references videos
title         text
start_time    interval
end_time      interval
hook_text     text            -- 冒頭フック案
platform_targets text[]       -- ['instagram','tiktok','youtube_shorts']
status        text default 'proposed'  -- proposed | approved | rejected | posted
```

### posts（投稿：プラットフォーム別、videoに対して複数）
```sql
id            uuid primary key
organization_id uuid references organizations
video_id      uuid references videos      -- nullable（動画本編以外の告知投稿等も許容）
channel_id    uuid references channels
platform      text not null
caption       text
hashtags      text[]
scheduled_at  timestamptz
published_at  timestamptz
status        text not null default 'draft'  -- draft | scheduled | published | failed
post_url      text
```

### kpi_channel_snapshots / kpi_video_snapshots（時系列）
```sql
kpi_channel_snapshots (
  id uuid pk, channel_id uuid references channels, date date not null,
  subscribers int, views int, impressions int, reach int,
  ctr numeric, avg_view_duration_pct numeric,
  comments int, saves int, inquiries int,
  unique(channel_id, date)
)

kpi_video_snapshots (
  id uuid pk, video_id uuid references videos, date date not null,
  views int, ctr numeric, avg_view_duration_pct numeric,
  comments int, saves int, reach int, impressions int,
  unique(video_id, date)
)
```

### competitors（競合トラッキング：アイデア提案の入力源）
```sql
id           uuid primary key
organization_id uuid references organizations
platform     text not null
channel_name text not null
channel_url  text not null
notes        text
last_synced_at timestamptz
```

### inquiries（問い合わせ：KPIの最終指標）
```sql
id           uuid primary key
organization_id uuid references organizations
video_id     uuid references videos
source       text            -- どの動画/投稿経由か
contact_name text
company      text
message      text
created_at   timestamptz
```

### tasks（ダッシュボードの「今週のタスク」）
```sql
id           uuid primary key
organization_id uuid references organizations
video_id     uuid references videos
title        text not null
assignee_id  uuid references users
due_date     date
status       text default 'todo'  -- todo | doing | done
created_by   uuid references users
```

### ai_generations（AI生成の全履歴：監査・再利用・精度改善の基盤）
```sql
id           uuid primary key
organization_id uuid references organizations
video_id     uuid references videos      -- nullable（レポート生成等は動画非紐づけ）
type         text not null
  -- idea | title | thumbnail | script | questions | edit_instruction
  -- shorts | caption | hashtag | kpi_analysis | improvement | report
prompt       text not null
input_context jsonb
output       text not null
model        text not null       -- 使用したClaudeモデル
created_by   uuid references users  -- nullable（バッチジョブ発火時）
created_at   timestamptz
```

### reports（月次レポート）
```sql
id                     uuid primary key
organization_id        uuid references organizations
period                 text not null     -- 'YYYY-MM'
summary                text
achievements           text
improvements           text
successful_ideas       jsonb
failed_ideas           jsonb
next_month_suggestions text
status                 text default 'draft'  -- draft | final
finalized_by           uuid references users
finalized_at           timestamptz
unique(organization_id, period)
```

### activity_logs（監査ログ）
```sql
id           uuid primary key
organization_id uuid references organizations
actor_id     uuid references users
entity_type  text not null
entity_id    uuid not null
action       text not null
created_at   timestamptz
```

## 4.3 RLSポリシーの方針
すべてのテーブルで以下の形のポリシーを基本形とする：

```sql
create policy org_isolation on videos
  using (organization_id in (
    select organization_id from memberships where user_id = auth.uid()
  ));
```

書き込み系ポリシーは role に応じてさらに絞る（例：`editor` は担当動画のみ更新可、`viewer` は更新不可）。
