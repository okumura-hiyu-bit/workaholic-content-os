# 5. データ構造（動画・音声・SNS投稿を1収録にまとめる）

## 5.1 3階層構造 — Content Repurposing の器

基本思想（[01](./01-architecture.md) 1.0）をそのままデータ構造にします。

```
📼 episodes（収録 = 親）
   ep012「中小企業が採用で勝つためのブランディング」
   │
   ├─ 📦 deliverables（成果物 = 素材の実体）
   │     main.mp4        本編動画
   │     short_01.mp4    ショート①（辞退率の話）
   │     short_02.mp4    ショート②（正直な自己紹介）
   │     ep012.mp3       音声ポッドキャスト
   │     thumb_main.jpg  サムネイル
   │
   └─ 📤 posts（投稿 = 媒体 × 成果物）
         main.mp4      × YouTube            → 承認済み
         short_01.mp4  × YouTube Shorts     → 公開済み
         short_01.mp4  × Instagram Reels    → 予約投稿済み
         short_01.mp4  × TikTok             → 確認待ち
         short_02.mp4  × Instagram Reels    → 修正中
         ep012.mp3     × Podcast(RSS)       → 承認済み
         —             × X（告知）           → 素材準備中
```

**なぜ `deliverables` と `posts` を分けるのか**

同じ `short_01.mp4` が Instagram・TikTok・YouTube Shorts の3媒体に出ます。ファイルは1つ、投稿は3つ、文面は3種類（媒体ごとに別物）。ここを1つのテーブルにまとめると、「同じ動画なのに媒体ごとに成績が違う」という**最も価値のある分析ができなくなります。**

この分離により、次の3つの比較が可能になります。

| 比較 | 分かること |
|---|---|
| 同一収録の **ショート① vs ショート②** | どの切り口が効いたか（＝企画力の検証） |
| 同一素材の **Instagram vs TikTok** | どの媒体が自社に合っているか |
| 同一収録の **長尺 vs ショート vs 音声** | どの形式で届いているか |

---

## 5.2 スプレッドシート構成（6シート）

### ① `episodes` — 収録マスタ（親）

| 列 | 例 | 記入 |
|---|---|---|
| episode_id | ep012 | 自動 |
| channel_id | wh_main | 自動（★将来のクライアント展開用） |
| title | 中小企業が採用で勝つためのブランディング | AI→人 |
| theme | 採用ブランディング | brief |
| guest | 山田太郎（株式会社◯◯ 人事部長） | brief |
| recorded_at | 2026-07-15 | brief |
| target_publish | 2026-07-22 | brief |
| status | 素材準備中 / 進行中 / 公開済み / アーカイブ | 自動 |
| transcript_url | 文字起こしへのリンク | 自動 |
| brief_summary | 要点（AIが要約） | 自動 |
| note | 自由記入 | 人 |

`channel_id` を最初から全シートに入れておくことで、**Phase2でクライアント案件を追加するときにデータ構造を変えずに済みます。** 現在は `wh_main` 固定です。

### ② `deliverables` — 成果物（素材の実体）

| 列 | 例 |
|---|---|
| deliverable_id | ep012_short_01 |
| episode_id | ep012 |
| type | long_video / short_video / audio / thumbnail / image |
| filename | shorts/short_01.mp4 |
| angle | 辞退率の話（★この素材の「切り口」） |
| source_timecode | 01:23-02:10 |
| duration_sec | 47 |
| media_url | R2の公開URL |
| file_size | 28311552（RSSのenclosureに必要） |
| status | 素材準備中 / 準備完了 |

**`angle`（切り口）列が分析の要です。** 「どの切り口が伸びたか」を集計するためのキーになります。AIが `brief.md` のショート候補から自動記入します。

### ③ `posts` — 投稿（媒体 × 成果物）★承認の対象

| 列 | 内容 |
|---|---|
| post_id | 自動採番 |
| episode_id / deliverable_id | 親への参照 |
| platform | youtube / youtube_shorts / instagram_reels / tiktok / podcast / x |
| **title** | タイトル（編集可） |
| title_options | AI候補3〜5案 |
| **body** | 概要欄・キャプション・説明文（編集可） |
| **hashtags** | ハッシュタグ（編集可） |
| thumbnail_text | サムネ文言案 |
| **scheduled_at** | 投稿予定日時（編集可） |
| **status** | ★8状態（5.3参照） |
| approved_by / approved_at | 承認記録（自動） |
| post_url / posted_at | 公開後（自動） |
| error | 失敗時の内容 |
| ai_original | AI生成の原文（差分学習用・非表示列） |

### ④ `podcast_episodes` — RSS配信用メタ情報

`posts` の podcast 行だけでは表現できない、RSS固有の項目を持ちます。

| 列 | 内容 |
|---|---|
| episode_id | ep012 |
| guid | workaholic-ep012（★**絶対に変更しない**） |
| episode_number | 12 |
| season | 1 |
| itunes_summary | 説明文（プレーンテキスト） |
| content_html | 説明文（HTML・チャプター併記） |
| chapters_json | `[{"startTime":0,"title":"オープニング"},…]` |
| persons | `[{"role":"host","name":"岸本"},{"role":"guest","name":"山田太郎"}]` |
| keywords | 検索用キーワード（カンマ区切り） |
| episode_image_url | エピソード画像 |
| duration_sec / file_size | 自動計測 |
| explicit | false |

### ⑤ `kpi_daily` — 日次数値（自動追記）

| 列 | 備考 |
|---|---|
| date / channel_id / platform | |
| scope | channel / post |
| ref_id | post_id またはチャンネルID |
| followers | 登録者・フォロワー |
| views | 再生数 |
| **downloads** | ★ポッドキャスト用（OP3から取得） |
| impressions / reach / ctr / avg_view_pct | 媒体により空欄 |
| comments / saves / shares | |
| inquiries | 手入力 |
| source | api / op3 / manual_csv（★どこから来た数値か） |

**`source` 列を持つ理由**: ポッドキャストのSpotify/Apple数値は手動CSVインポートになります（[09](./09-podcast.md) 9.6）。自動取得値と手入力値を区別できないと、欠測なのか実際に0なのかが判断できず、分析が狂います。

### ⑥ `ideas` — 企画ストック

| 列 | 内容 |
|---|---|
| idea_id / title / summary | |
| source | trend / competitor / news / kpi_analysis / manual |
| source_url | 根拠URL |
| favorite | ★チェックボックス |
| status | new / reviewing / adopted / rejected |
| linked_episode | 動画化した場合 |

---

## 5.3 ステータス（9状態）

ご指定の8状態に、Premiere連携で必要になる **編集中** を追加しています（[11](./11-editing-pipeline.md) 11.8）。全媒体で共通です。

| # | 状態 | 意味 | 遷移させるもの |
|---|---|---|---|
| 1 | **素材準備中** | 素材がまだ揃っていない | 人（`raw/` にファイル投入） |
| 2 | **AI生成待ち** | 素材は揃った。解析前 | `ingest` コマンド |
| 3 | **編集中** | XML生成済み。**Premiereでの作業待ち** | `ingest` 完了で自動 |
| 4 | **確認待ち** | 書き出し完了。あなたの確認待ち | `watch` が検知して自動 ← ★ここに溜まる |
| 5 | **修正中** | 文面を編集中（他者と共有時の目印） | 人（管理画面） |
| 6 | **承認済み** | ★**投稿対象になる唯一の状態** | 人（管理画面） |
| 7 | **予約投稿済み** | 媒体側に予約が登録された | システム |
| 8 | **公開済み** | 公開完了 | システム |
| 9 | **投稿失敗** | エラー。原因が記録される | システム |

```
素材準備中 → AI生成待ち → 編集中 → 確認待ち ⇄ 修正中
                            ↑         ↓
                        （差し戻し）  承認済み ←── 承認取消で戻せる
                                        ↓
                                 予約投稿済み → 公開済み
                                        ↓
                                    投稿失敗 → （修正して承認済みに戻すと再試行）
```

**`編集中` を独立させた理由**: ダッシュボードで「今Premiereで作業待ちのもの」と「確認待ちのもの」を区別できるようにするためです。この2つは必要なアクションがまったく違う（Premiereを開くか、ブラウザで承認するか）ので、同じ状態にまとめると何をすべきか分からなくなります。

遷移ルールは [`packages/core/src/status.ts`](../packages/core/src/status.ts) に実装済みで、テストで固定されています。`編集中` から `承認済み` へ飛び越えることはできません（確認を必ず通す）。

**投稿処理は `承認済み` と `予約投稿済み` の行しか見ません。** それ以外の6状態はコード上、投稿処理の対象として存在しません（[04](./04-approval-flow.md)）。

---

## 5.4 ローカルフォルダ

```
content/2026-07/ep012_採用ブランディング/
├── brief.md              ← あなたが書く唯一のファイル
├── main.mp4              ← 本編マスター
├── shorts/
│   ├── short_01.mp4      ← 90秒以内・9:16（リール要件）
│   └── short_02.mp4
├── audio/
│   └── ep012.mp3         ← 任意。無ければmain.mp4から自動生成
├── thumbnail/
│   ├── main.jpg
│   └── ep012_cover.jpg   ← ポッドキャストのエピソード画像
├── transcript.txt        ← 自動生成（Whisper）
└── exports/              ← 手動投稿用の書き出し先
    └── tiktok/
```

`content/` をGoogle Driveの同期フォルダ内に置けば、バックアップと編集者への受け渡しがそのまま実現できます。追加実装は不要です。

---

## 5.5 なぜスプレッドシートのままなのか

管理画面を作る以上、データベース（Cloudflare D1 など）に移す選択肢もありますが、**当面はスプレッドシートを正とします。**

| | 判断 |
|---|---|
| 費用 | どちらも0円（D1も無料枠あり）→ **決め手にならない** |
| **管理画面が壊れたとき** | Sheetsなら**業務が止まらない**。直接開いて承認・修正できる ← ★最大の理由 |
| あなたが直接直せるか | Sheets ○ / D1 ✗（SQLが必要） |
| 一括編集・その場でのグラフ化 | Sheets ○ |
| 速度 | D1が有利（Sheetsは1リクエスト0.3〜1秒） |
| 行数の上限 | 週6投稿で年間約400行。10年動く |

**新しく作った管理画面に業務を完全依存させないこと**が、1人運用のシステムでは重要です。管理画面はあくまで「快適な操作層」で、データの正はいつでも人が触れる場所に置いておきます。

速度が問題になったら、Workers KV（無料）に60秒キャッシュを挟みます。それでも足りなくなる規模＝クライアント案件が増えた段階で、`packages/core/sheets.ts` の実装だけをD1に差し替えます。**各シートがそのままテーブル定義になっているため、移行時にデータ構造の変更は発生しません。**
