# 9. 音声ポッドキャスト配信設計

## 9.1 結論：自前RSS配信 + Cloudflare R2 が最適

各社に個別投稿するのではなく、**自分でRSSフィードを持ち、それを各サービスに登録する**構成にします。ご要望どおりRSS中心の設計です。

```
   episode.mp3（編集データから書き出し）
        ↓  stage コマンド
   Cloudflare R2（10GB無料・エグレス無料）
        ↓
   https://media.workaholic.co.jp/ep012.mp3
        ↓  RSSに記載するURLはOP3プレフィックス経由にする
   https://op3.dev/e/media.workaholic.co.jp/ep012.mp3
        ↓
   https://podcast.workaholic.co.jp/feed.xml  ← Cloudflare Workersが動的生成
        ↓  一度登録すれば以降は自動
   Spotify / Apple Podcasts / Amazon Music / その他RSS対応サービス
```

**このやり方の利点**
- ホスティング費用**0円**（R2はエグレス＝配信量が無料。ポッドキャストは配信量が最大のコスト要因なので、ここが無料なのは決定的です）
- サービスが増えてもRSSを登録するだけ。投稿処理を媒体ごとに実装する必要がない
- **予約公開にcronすら不要**（後述 9.4）
- ホスティング会社への依存がゼロ。将来値上げ・サービス終了の影響を受けない

---

## 9.2 音声ファイルの保存先

| 選択肢 | 費用 | 判定 |
|---|---|---|
| **Cloudflare R2** | 10GB無料・**エグレス無料** | ✅ **採用** |
| Amazon S3 | 転送量課金（配信が伸びるほど高額に） | ✗ ポッドキャストに最も不向き |
| Spotify for Creators（旧Anchor） | 無料 | △ 後述 9.7 |
| 一般的なポッドキャストホスティング | 月1,500〜3,000円 | ✗ 不要 |

**容量試算**: 128kbps・30分＝約28MB。R2の10GB無料枠で**約350エピソード**。週1本なら6年以上、追加費用ゼロで運用できます。超えても1GBあたり月2.3円程度です。

R2にカスタムドメイン（`media.workaholic.co.jp`）を割り当てます。Cloudflareの無料プランで設定可能です。

---

## 9.3 RSSフィードの生成方法

**Cloudflare Workers が、アクセスのたびにスプレッドシートを読んでRSSを動的生成します。** 静的ファイルを書き出して置く方式にしない理由は、9.4の予約公開のためです。

### フィードの構造

```xml
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:podcast="https://podcastindex.org/namespace/1.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>WORKAHOLIC RADIO</title>
    <link>https://workaholic.co.jp/podcast</link>
    <description>企業の情報発信を仕組み化する…</description>
    <language>ja</language>
    <itunes:author>WORKAHOLIC株式会社</itunes:author>
    <itunes:owner>
      <itunes:name>WORKAHOLIC株式会社</itunes:name>
      <itunes:email>podcast@workaholic.co.jp</itunes:email>  ← ★所有権確認に使用
    </itunes:owner>
    <itunes:image href="https://media.workaholic.co.jp/cover.jpg"/>  ← 3000×3000
    <itunes:category text="Business"><itunes:category text="Entrepreneurship"/></itunes:category>
    <itunes:explicit>false</itunes:explicit>
    <itunes:type>episodic</itunes:type>

    <item>
      <title>第12回 中小企業が採用で勝つためのブランディング</title>
      <guid isPermaLink="false">workaholic-ep012</guid>   ← ★絶対に変更しない
      <pubDate>Wed, 22 Jul 2026 18:00:00 +0900</pubDate>
      <enclosure url="https://op3.dev/e/media.workaholic.co.jp/ep012.mp3"
                 length="28311552" type="audio/mpeg"/>
      <itunes:duration>1832</itunes:duration>
      <itunes:episode>12</itunes:episode>
      <itunes:image href="https://media.workaholic.co.jp/ep012_cover.jpg"/>
      <itunes:summary>…</itunes:summary>
      <content:encoded><![CDATA[ 説明文（HTML可）+ チャプター一覧 ]]></content:encoded>
      <podcast:person role="host">岸本</podcast:person>
      <podcast:person role="guest">山田太郎</podcast:person>
      <podcast:chapters url="https://podcast.workaholic.co.jp/ep012/chapters.json"
                        type="application/json+chapters"/>
    </item>
  </channel>
</rss>
```

**運用上の絶対ルール**
- `guid` は一度発行したら**絶対に変更しない**。変更すると全リスナーの配信アプリで「新しいエピソード」として重複表示されます
- `<itunes:owner><itunes:email>` は所有権確認に使われるため、受信できるアドレスを設定する
- `enclosure` の `length`（バイト数）は正確に。ここが誤っているとApple Podcastsで再生不具合が起きます。`stage` コマンドが自動で埋めます

### チャプター
Podcasting 2.0 の JSON Chapters 形式（`/ep012/chapters.json`）で配信します。対応アプリ（Apple Podcasts、Overcast、Podcast Addict等）で章送りができるようになります。Spotifyは説明文内のタイムスタンプ表記を自動認識するため、**説明文にも `00:00 オープニング` 形式でチャプターを併記**します。AIが両方の形式を同時に生成します。

---

## 9.4 予約公開の仕組み（cron不要）

RSSはリスナー側のアプリが定期的に取りに来る「プル型」です。この性質を利用します。

> **Workerは、`status = 承認済み` かつ `scheduled_at <= 現在時刻` のエピソードだけをフィードに含めます。**

つまり、公開時刻が来ると**次にフィードが読まれた瞬間から自動的に配信が始まります。** 投稿処理も cron も一切必要ありません。動画SNSの投稿処理と比べて圧倒的にシンプルで、失敗する箇所がありません。

**承認前のエピソードは、そもそもフィードに1バイトも出力されない**ため、誤配信が構造的に起こり得ません（[04-approval-flow.md](./04-approval-flow.md) の安全装置がここでも効きます）。

反映までのタイムラグは、SpotifyやApple側のフィード取得間隔に依存し、通常**数分〜数時間**です。「18:00ちょうどに配信」という精度は出ないため、**公開日単位で管理する運用**を前提にしてください（ポッドキャストでは一般的な運用です）。

---

## 9.5 Spotify / Apple Podcasts への初期登録

**すべて無料です。** 各サービス1回ずつ、初回のみの作業です。

| # | サービス | 手順 | 所要 | 審査 |
|---|---|---|---|---|
| 1 | **Apple Podcasts** | [Podcasts Connect](https://podcastsconnect.apple.com) にApple IDでログイン → RSSのURLを送信 → `itunes:owner` のメール宛の確認を経て審査 | 15分 | 数日〜1週間 |
| 2 | **Spotify** | [Spotify for Creators](https://creators.spotify.com) でRSSを登録 → フィード内のメールアドレスで所有権確認 | 10分 | 即日〜数時間 |
| 3 | **Amazon Music** | [podcasters.amazon.com](https://podcasters.amazon.com) でRSSを登録 | 10分 | 24〜48時間 |
| 4 | YouTube Music / その他 | 同様にRSS登録 | 各5分 | 即日 |

**登録前に必ず用意するもの**
- カバー画像 3000×3000px（**これが無いとAppleの審査で確実に落ちます**）
- **最低1エピソードが公開されているフィード**（空のフィードは登録できない）
- `itunes:owner` に設定した受信可能なメールアドレス
- 番組説明文、カテゴリ（Business > Entrepreneurship を推奨）

登録は**エピソード1本目を作った直後**に済ませてください。審査に1週間かかることがあるためです。

---

## 9.6 公開後の数値取得 ← ここが最も注意が必要です

調査した結果、**ポッドキャストの分析は動画SNSほど自動化できません。** 正確にお伝えします。

| 取得したいもの | 自動取得 | 方法 |
|---|---|---|
| **総ダウンロード数**（全サービス横断） | ✅ **可能** | **OP3**（後述）— 無料・API・IAB2.0準拠 |
| エピソード別ダウンロード数 | ✅ 可能 | 同上 |
| 再生アプリ・地域の内訳 | ✅ 可能 | 同上 |
| Spotify の再生数・フォロワー数 | ❌ **不可** | 管理画面から手動CSV取得（月1回） |
| Spotify の視聴完了率 | ❌ 不可 | 同上 |
| **Apple の再生数・完了率** | ❌ **不可（規約で禁止）** | 管理画面から手動CSV取得（月1回） |
| Amazon Music の再生数 | ❌ 不可 | 管理画面から手動取得 |

**⚠️ Apple Podcasts Connect は利用規約でプログラムによるアクセス（スクレイピング含む）を明示的に禁止しています。** 非公式な手段は使わないというご方針に沿い、Appleの数値は**手動CSVインポート**とします。管理画面に「CSVをドラッグ＆ドロップ」する機能を用意するので、月1回・3分程度の作業になります。

### OP3（Open Podcast Prefix Project）を採用します

- **完全無料・オープンソース・サインアップ不要**
- MP3のURLの前に `https://op3.dev/e/` を付けるだけで計測が始まる
- IAB 2.0 準拠のダウンロード計測（業界標準の数え方なので、他社と比較可能な数値になります）
- **APIとCSVエクスポートあり** → KPI取得を自動化できる
- IPアドレスは保存されずハッシュ化される（プライバシー配慮）
- 330都市のエッジで動作し、配信速度への悪影響はほぼない

**OP3の数値を「ポッドキャストの主指標」に据えます。** 各サービス個別の数値は補助的に月次で手入力する、という役割分担が、無料の範囲で最も正確な計測方法です。

---

## 9.7 「Spotify for Creators に無料ホスティングさせる」案を採用しない理由

Spotify for Creators（旧Anchor）は無料でホスティング＋RSS生成をしてくれますが、**採用しません。**

| 論点 | 自前RSS（採用） | Spotify for Creators |
|---|---|---|
| 費用 | 0円 | 0円 |
| RSSの所有権 | **自社** | Spotify |
| 配信先の自由度 | 任意 | Spotifyの都合に依存 |
| Spotifyから離脱するとき | 影響なし | **RSSのURLが変わり、リスナーの購読が切れる** |
| 自動化 | フルコントロール | アップロードAPIに制約 |
| Phase2でクライアントに提供 | そのまま可能 | 各社のSpotifyアカウントに依存し破綻 |

費用が同じである以上、**RSSの主導権を自社が持つ構成**を選ぶべきです。特に「将来クライアントに同じ仕組みを提供する」というPhase2の目的を考えると、他社プラットフォームに配信基盤を握られる構成は選べません。

---

## 9.8 音声仕様（推奨値）

ご提示の想定は妥当です。その上で、実運用で問題が起きにくい値を提案します。

### 音声ファイル

| 項目 | 推奨値 | 理由 |
|---|---|---|
| 形式 | **MP3**（LAME） | 全サービスで最も互換性が高い。AACは一部アプリで問題が出る |
| ビットレート | **128kbps CBR** | 音楽入りの対談として十分。VBRではなくCBRを推奨（一部アプリでVBRの再生位置がずれるため） |
| サンプルレート | **44.1kHz** | 48kHzでも可だが、44.1kHzが最も無難 |
| チャンネル | **ステレオ** | 複数話者の定位が保たれる。純粋な会話のみなら96kbpsモノラルでも可 |
| **ラウドネス** | **-16 LUFS（統合）** | ★重要。ポッドキャストの業界標準。Appleは-16、Spotifyは-14に自動正規化するため、-16で納品すれば両方で自然に鳴る |
| トゥルーピーク | **-1.0 dBTP 以下** | 変換時の歪みを防ぐ |

**ラウドネス統一は音声ポッドキャストで最も重要な品質要素です。** 回によって音量がバラつくとリスナーが離脱します。`stage` コマンドで ffmpeg の `loudnorm` フィルタを使い、**2パス処理で自動的に -16 LUFS に統一**します。ここは人手を介さず機械的に処理すべき箇所です。

### 画像

| 項目 | 推奨値 |
|---|---|
| 番組カバー | **3000×3000px** JPEG/PNG、RGB、1MB以下 |
| エピソード画像 | 1400×1400〜3000×3000px（任意だが推奨） |
| 注意 | 正方形必須。小さい文字は入れない（アプリ内では最小55px程度で表示されるため） |

### ID3タグ
`title` / `artist`（番組名）/ `album`（番組名）/ `track`（話数）/ `year` / `genre = Podcast` / 埋め込みアートワーク。`stage` コマンドが自動付与します。

---

## 9.9 動画からのMP3自動書き出し

**優先順位**（ご指摘のとおり、音質劣化を避ける順序にします）

```
1位: 編集ソフトから直接書き出したWAV/MP3があれば、それを使う   ← 最良
2位: 手元の完パケMP4（マスター）から ffmpeg で抽出            ← 実質1位と同等
3位: YouTubeにアップした動画から取得                          ← 使わない
```

**3位を使わない理由**: YouTube上の動画は既にYouTube側で再エンコードされており、そこから音声を取り出すと**二重圧縮で明確に音質が劣化します**。加えてYouTubeの利用規約上の問題もあります。**手元にマスターMP4が必ずある**運用なので、3位が必要になる場面はありません。

### 実装（`extract-audio` コマンド）

```bash
# 1. マスターMP4から音声を抽出（無劣化でWAVに）
ffmpeg -i main.mp4 -vn -acodec pcm_s16le -ar 44100 -ac 2 temp.wav

# 2. ラウドネス測定（1パス目）
ffmpeg -i temp.wav -af loudnorm=I=-16:TP=-1:LRA=11:print_format=json -f null -

# 3. 測定値を使って正規化しつつMP3化（2パス目）
ffmpeg -i temp.wav -af loudnorm=I=-16:TP=-1:LRA=11:measured_I=…:linear=true \
       -c:a libmp3lame -b:a 128k -ar 44100 -ac 2 ep012.mp3

# 4. ID3タグ・アートワーク付与、長さ・バイト数を取得してシートに記録
```

`content/2026-07/ep012/audio/` に既にMP3/WAVが置かれていればそれを優先し、無ければMP4から自動生成します。**あなたはファイルを置くか置かないかを判断するだけで、どちらでも動きます。**

---

## Sources
- [OP3: The Open Podcast Prefix Project](https://op3.dev/)
- [Download Calculation · OP3](https://op3.dev/download-calculation)
- [Apple Podcast Connect's terms of service, Feb 2026 | Podnews](https://podnews.net/article/apple-podcast-connect-tos-26)
- [Introducing a New Standard for Podcast Plays and Upgraded Creator Analytics | Spotify Newsroom](https://newsroom.spotify.com/2026-06-11/spotify-for-creators-tools-plays-analytics-updates/)
- [The Complete Podcast Directory List For 2026 | RSS.com](https://rss.com/blog/podcast-directory-list/)
- [Cloudflare R2 — Egress-Free Object Storage](https://www.cloudflare.com/products/r2/)
