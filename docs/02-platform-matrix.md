# 2. 各SNSの自動投稿可否・分析データ取得可否

**この設計で最も重要なドキュメントです。** 「どこまで自動化できるか」はこちらの実装力ではなく、プラットフォーム側の審査・アカウント種別・API仕様で決まります。楽観的な想定で設計すると後で破綻するため、現時点（2026年7月）の公式仕様に基づいて厳密に整理します。

---

## 2.1 結論：A / B / C 分類

| 媒体 | 投稿の自動化 | ランク | 一言 |
|---|---|---|---|
| **YouTube（本編）** | 完全自動＋予約投稿◎ | **A** | 何の障壁もない。ここは今日から自動化できる |
| **YouTube Shorts** | 完全自動＋予約投稿◎ | **A** | 本編と同じAPI。縦型・3分以内で自動判定される |
| **Instagram フィード** | 自動可（初期設定必須） | **B** | ビジネスアカウント＋Meta開発者アプリの設定が必要。審査は原則不要 |
| **Instagram リール** | 自動可（初期設定必須） | **B** | 同上。ただし予約投稿はAPI側に無いので自前スケジューラで実行 |
| **TikTok** | 審査次第 | **B → C** | **審査を通すまで公開投稿ができない。** 当面はCランク運用を推奨 |
| **X（将来）** | 有料 | **C** | 無料枠は月500投稿だが分析APIが実質使えない。優先度低 |

---

## 2.2 【A】無料・公式APIで完全自動化できるもの

### YouTube（本編／Shorts）

**投稿**
- API: YouTube Data API v3 `videos.insert`
- 動画ファイルを直接アップロードできる（公開URL不要）
- **予約投稿はAPI標準機能としてサポート**: `privacyStatus: "private"` ＋ `publishAt: <ISO8601日時>` を指定すれば、指定時刻に自動で公開される。つまり「予約投稿の時刻管理をこちらで持たなくてよい」＝最も信頼性が高い
- Shortsは専用APIではなく同じ `videos.insert`。縦型（9:16）かつ3分以内なら自動的にShortsとして扱われる
- サムネイル設定: `thumbnails.set`（別途画像が必要）

**クォータ（2026年時点で大幅に緩和されています）**
- 2025年12月4日より、アップロードのコストが1,600ユニット → **約100ユニット**に引き下げ
- 2026年6月1日より、`videos.insert` は**1日約100回の専用枠**で課金され、読み取り用の10,000ユニット枠と競合しなくなった
- → 週2〜3本の運用では、クォータは**まったく問題になりません**

**⚠️ ひとつだけ注意点：OAuthトークンの7日問題**

Google Cloudのアプリを「テスト中（Testing）」のまま使うと、**リフレッシュトークンが7日で失効**します。毎週再認証する羽目になり、自動化が破綻します。

**回避策**（初期設定時に必ず実施）:
1. Google Cloud Console でOAuth同意画面の公開ステータスを **「本番環境（In production）」** に変更する
2. 審査（verification）は出さなくてよい。未審査のまま本番にすると、初回認証時に「このアプリは確認されていません」という警告画面が出るが、自分のアカウントなので「詳細 → 移動」で進める
3. これでリフレッシュトークンは無期限になる

**分析データ**
- API: YouTube Analytics API（無料・別クォータ）
- 取得できる: 登録者数、再生数、インプレッション、**CTR（impressions click-through rate）**、**平均視聴維持率（average view percentage）**、平均視聴時間、コメント数、高評価数、共有数、トラフィックソース
- 自チャンネルの数値なので制限なく取得可能。**要望の指標がほぼすべて揃うのはYouTubeだけです**

---

## 2.3 【B】初期設定・審査後に自動化できるもの

### Instagram（フィード／リール）

**必要な前提条件**
1. Instagramアカウントを**プロアカウント（ビジネス or クリエイター）**に変更
2. Facebookページと連携
3. Meta for Developers でアプリを作成（Business型）
4. `instagram_business_basic` / `instagram_business_content_publish` / `instagram_business_manage_insights` の権限を設定
5. **自分のアカウントをアプリの「管理者／テスター」として登録**

**審査（App Review）は必要か → 原則不要です**
Meta のアプリは「開発モード」のままでも、**アプリに役割（管理者・開発者・テスター）を持つアカウントに対しては本番同様に動作**します。今回は自社アカウントのみが対象なので、開発モード＋標準アクセスで運用できます。
※ 将来クライアントのアカウントを扱う段階になったら、そこで初めてApp Review（2〜4週間）が必要になります。

**投稿の仕組みと制約**
- 3ステップ: ①メディアコンテナ作成（`/media`）→ ②ステータスが `FINISHED` になるまでポーリング → ③公開（`/media_publish`）
- **動画は「公開URL」で渡す必要がある**（バイナリ直接アップロード不可）→ これが Cloudflare R2 を使う理由
- **予約投稿機能はAPIに存在しない。** 指定時刻に自分で `/media_publish` を叩く必要がある → GitHub Actions の毎時cronがこの役割を担う
- 投稿数上限: 24時間あたり50件（十分）

**リールとして扱われる条件**
- `media_type=REELS`、9:16、**5〜90秒**、H.264またはHEVC
- 90秒を超えると通常の動画投稿になりリールタブに出ない → **ショート動画は90秒以内で書き出すルールを制作側で徹底する必要があります**（これは仕様上どうにもならないので、運用ルールとして固定してください）

**分析データ**
- API: `/{ig-media-id}/insights`、`/{ig-user-id}/insights`
- 取得できる: **views、reach、saved（保存数）、shares、likes、comments**、フォロワー数
- ⚠️ 2025年1月以降、`impressions` と `video_views` は廃止され **`views` に統合**されました。「インプレッション」はInstagramでは取得できないため、KPI設計では**リーチ**を主指標に置きます
- ⚠️ CTR・視聴維持率に相当する指標はAPIでは取得できません（アプリ内のインサイト画面でのみ確認可能）

### TikTok

**現状：ここが一番厳しいです**

- API: Content Posting API（`/v2/post/publish/video/init/`）
- 動画はバイナリ直接アップロード可（`FILE_UPLOAD`）なので、公開URLは不要。URL経由（`PULL_FROM_URL`）を使う場合はドメイン所有権の検証が必要
- **審査（Content Posting API audit）を通過するまで、投稿はすべて `SELF_ONLY`（自分だけが見える非公開）になります。** つまり審査前は実質的に使えません
- 審査には2〜4週間、投稿フローの録画デモ・プライバシーポリシーURL・「完成した製品の一部であること」の証明が必要
- 未審査アプリは24時間に5ユーザーまでという制限もあり

**推奨する進め方**
> Phase1では **TikTokはCランク（手動投稿）** として運用してください。
> `export` コマンドで動画ファイルとキャプション・ハッシュタグを1フォルダに書き出し、スマホから手動投稿します。所要時間は1本あたり1〜2分です。
> 並行して審査申請を出し、通過したらBランク（自動投稿）に昇格させます。**設定ファイルの1行（`autoPost: false → true`）を変えるだけで切り替わる**ように実装します。

**分析データ**
- API: Display API `/v2/video/list/`（無料）
- 取得できる: **再生数、いいね数、コメント数、シェア数**、動画メタ情報
- ⚠️ 視聴維持率・FYPインプレッション・オーディエンス属性は**いかなる公式APIでも取得できません**
- ⚠️ アクセストークンの有効期限が24時間と短いため、リフレッシュ処理の実装が必須

---

## 2.4 【C】自動化が難しく、手動投稿するもの

| 対象 | 理由 | システムがやること |
|---|---|---|
| TikTok（審査通過まで） | 未審査だと公開投稿不可 | 動画＋キャプション＋ハッシュタグを `exports/tiktok/` に書き出し、リマインド通知 |
| Instagram ストーリーズ | APIサポートが不安定で優先度が低い | 同上 |
| X（Twitter） | 無料枠では分析APIが実用にならず、投稿APIも制限が厳しい | 同上（Phase2以降で再検討） |

**Cランクの運用**: 承認済みの投稿予定時刻になると、GitHub Actionsが「手動投稿してください」という通知（メール or Slack）を出し、書き出し済みフォルダのリンクを添えます。**投稿URLをシートに手で貼ってもらえば、KPI取得は自動化されます**（投稿だけが手動で、分析は自動という状態を作れます）。

---

## 2.5 KPI取得の可否一覧

要望いただいた指標がどこまで取れるかの正確な対応表です。

| 指標 | YouTube | Instagram | TikTok |
|---|---|---|---|
| 登録者／フォロワー数 | ✅ | ✅ | ✅ |
| 再生数 | ✅ | ✅（views） | ✅ |
| インプレッション | ✅ | ❌ 廃止 | ❌ |
| リーチ | △（ユニーク視聴者数で代替） | ✅ | ❌ |
| **CTR** | ✅ | ❌ | ❌ |
| **平均視聴維持率** | ✅ | ❌ | ❌ |
| コメント数 | ✅ | ✅ | ✅ |
| 保存数 | ❌ | ✅ | ❌ |
| シェア数 | ✅ | ✅ | ✅ |
| 問い合わせ数 | 手動入力 | 手動入力 | 手動入力 |

**この表から導かれる運用方針**
- **CTRと視聴維持率はYouTubeでしか測れません。** したがって「企画の良し悪しの判定」はYouTubeの数値を主軸に行い、Instagram/TikTokは「リーチと保存数」で補助的に見るのが正しい設計です。全媒体で同じ指標を並べようとすると必ず破綻します
- 問い合わせ数はAPIでは取得不可能なので、シートに手入力する列を用意します（月に数件なので手間はほぼゼロ）

---

## Sources
- [YouTube Data API Overview | Google for Developers](https://developers.google.com/youtube/v3/getting-started)
- [YouTube Upload API: Videos & Shorts (2026) | Postproxy](https://postproxy.dev/blog/youtube-upload-api-guide/)
- [Google OAuth Refresh Token: Expiration, 7-Day Limit & Lifetime Explained (2026) | Unipile](https://www.unipile.com/google-oauth-refresh-token/)
- [Publish Content using the Instagram Platform | Meta Developer Documentation](https://developers.facebook.com/docs/instagram-platform/content-publishing/)
- [Insights - Instagram Platform | Meta for Developers](https://developers.facebook.com/docs/instagram-platform/insights/)
- [Instagram API Integration Guide 2026 | Phyllo](https://www.getphyllo.com/post/instagram-api-integration-101-for-developers-of-the-creator-economy)
- [TikTok Content Posting API in 2026: Direct Post, Audit, and Alternatives | PostPeer](https://www.postpeer.dev/blog/best-tiktok-posting-api)
- [Overview of the TikTok Display API](https://developers.tiktok.com/doc/display-api-overview)
