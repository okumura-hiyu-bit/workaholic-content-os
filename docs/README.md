# WORKAHOLIC Content OS — 設計

## これは何か

> **WORKAHOLICのAIアシスタントエディターです。動画編集ソフトではありません。**
>
> **目標：Premiereを開いた時点で編集作業の90%が完了している状態。**

Premiere Pro を置き換えるものではありません。編集者が最も時間を使う **準備・整理・反復作業**（音声同期・文字起こし・字幕・話者名・カメラ切替の初回組み・ショート候補探し・音量調整）をAIが引き受け、編集者は **演出・ストーリー・テンポ・感情表現** に集中できる状態を作ります。

## 基本思想：Content Repurposing

1回の収録を原資産とし、そこから媒体ごとに最適化されたコンテンツを生成します。同じ文章を各媒体にコピーするのではなく、**1つの素材から媒体ごとに別の作品**を作ります。この構造がデータ設計（1収録＝親、各媒体の成果物＝子）と分析軸（切り口別・形式別の比較）の根拠です。

## ワークフロー

```
収録
   ↓  素材を raw/ に保存（引き・寄りA・寄りB・別録り音声）
$ contentos analyze ep012
   ↓  15〜25分（席を離れていてOK）
   音声同期 / 話者判定 / 文字起こし / 話題区切り
   笑い・盛り上がり・強調ポイント検出
   カメラ切替案 / ショート候補6〜8本
   音声補正（非破壊・原音は保持）
   ↓
Premiereで ep012.fcp7.xml を開く
   ↓  機械的な操作（想定15操作・目標3分以内 / 実測前）
★編集の90%が完了した状態 → 演出・テンポ・間の確認へ
   ↓
書き出し → 承認（ブラウザ）→ 投稿 → 分析 → レポート
```

## Phase構成

| Phase | 内容 |
|---|---|
| **1（本MVP）** | 素材読込・音声同期・話者判定・文字起こし・**Premiereプロジェクト生成**・字幕・マーカー・ショート候補・YouTube書き出し |
| 2 | YouTube投稿・投稿文生成・KPI取得・月次レポート |
| 3 | Instagram・TikTok・**音声ポッドキャスト**・媒体別最適化・高度な分析 |

## コスト

**固定費 月額0円。** 動画素材はローカル／外付けSSDで管理し、クラウドが扱うのは**メタデータと設定情報のみ**です。有料サービスは「無料では実現できない」と実データで判断できてから導入します。

## ドキュメント

| # | ドキュメント | 内容 |
|---|---|---|
| 01 | [architecture.md](./01-architecture.md) | 全体構成・技術選定・ディレクトリ |
| 02 | [platform-matrix.md](./02-platform-matrix.md) | 各SNSの自動投稿・分析の可否（A/B/C分類） |
| 03 | [cost.md](./03-cost.md) | 費用設計・検証指標 |
| 04 | [approval-flow.md](./04-approval-flow.md) | 投稿承認フロー（安全装置） |
| 05 | [data-structure.md](./05-data-structure.md) | データ構造（収録→成果物→投稿の3階層） |
| 06 | [ai-prompts.md](./06-ai-prompts.md) | 媒体別の生成テンプレート |
| 07 | [kpi-and-report.md](./07-kpi-and-report.md) | 分析設計・月次レポート |
| 08 | [mvp-and-steps.md](./08-mvp-and-steps.md) | **MVP範囲・実装手順・Phase構成** |
| 09 | [podcast.md](./09-podcast.md) | 音声ポッドキャスト配信（Phase3） |
| 10 | [admin-ui.md](./10-admin-ui.md) | ブラウザ確認画面 |
| 11 | [editing-pipeline.md](./11-editing-pipeline.md) | ★**編集パイプライン（中核）** |
| 12 | [premiere-capability-matrix.md](./12-premiere-capability-matrix.md) | ★**Premiereに何を渡せるか（能力の境界）** |
| 13 | [gui-mvp.md](./13-gui-mvp.md) | ★**確認画面MVP・レイヤー分離・Electron構成** |
| 14 | [pipeline.md](./14-pipeline.md) | ★**パイプライン（15工程のオーケストレーション・実測記録）** |
| — | [archive/v1-webapp/](./archive/v1-webapp/) | 初期のSaaS型設計（将来のクライアント展開時に参照） |

**11 と 12 が中核です。** 特に12は「90%完了」が技術的に成立する根拠と、その限界を示しています。

## 設計の原則

1. **AIは編集判断をしない。** 無音・間・沈黙の削除は**機能として作りません**。言い直しも提示のみ。演出・テンポ・笑いの取捨は編集者の領域です。
2. **承認前は絶対に投稿しない。** ホワイトリスト方式・サーバー側での再検証など多重の安全装置で、運用ルールではなくコードで保証します。
3. **AIに投げるのは「意味の判断が必要な処理」だけ。** 同期・話者判定・笑い検出などは機械的に処理します。速く、確実で、無料枠を消費しません。
4. **公式サポートされた手段のみ。** ExtendScript（2026年9月終了）や非公開の.prproj形式には依存しません。スクレイピングも使いません。
5. **固定費0円。** 素材はローカル、クラウドはメタデータのみ。
6. **小さく試してから作る。** FCP7 XMLのPremiere実機検証を最初に行い、通ってから積み上げます。

## 実装状況

| | 状態 |
|---|---|
| ステータス定義・遷移ルール | ✅ 実装済み（[status.ts](../packages/core/src/status.ts)） |
| 投稿可否判定（承認制の担保） | ✅ 実装済み（[publish-guard.ts](../packages/core/src/publish-guard.ts)） |
| RSS生成（Phase3用） | ✅ 実装済み（[rss.ts](../workers/feed/src/rss.ts)） |
| カメラ切替案の算出 | ✅ 実装済み（[camera-plan.ts](../packages/editing/src/camera-plan.ts)） |
| テロップ生成（字幕・話者名・強調・チャプター） | ✅ 実装済み（[srt.ts](../packages/editing/src/srt.ts)） |
| **FCP7 XML生成** | ✅ 実装済み（[fcp7xml.ts](../packages/editing/src/fcp7xml.ts) / [build-project.ts](../packages/editing/src/build-project.ts)） |
| **音声同期**（相互相関） | ✅ 実装済み（[audio-sync.ts](../packages/editing/src/audio-sync.ts)）合成素材で誤差0ms |
| **話者判定**（相槌・同時発話・沈黙） | ✅ 実装済み（[speaker-detect.ts](../packages/editing/src/speaker-detect.ts)） |
| 笑い候補の検出 | ⚠️ **補助判定**。低確信度はカメラ切替に使わずマーカーのみ。実素材での閾値調整が必要 |
| **音声補正**（非破壊・ノイズ低減・ラウドネス正規化） | ✅ 実装済み（[audio-correct.ts](../packages/media/src/audio-correct.ts)）。★原音は上書きしない（入力パス＝出力パスなら実行前に例外）。補正音は別ファイルとして生成し、XMLでは原音を有効トラック・補正音をミュートトラックで出力 |
| ffmpeg連携（尺取得・音声デコード） | ✅ 実装済み（[ffmpeg.ts](../packages/media/src/ffmpeg.ts)） |
| **パイプライン自己検証** | ✅ 全10項目合格（[記録](./measurements/selfcheck-synthetic.md)） |
| テスト | ✅ **1048件パス**（41ファイル。内訳：コア 498件＋Electron 550件） |
| **Premiereでの実機検証** | ⏳ 実施待ち（[検証ガイド](./measurements/premiere-check-guide.md)） |
| **文字起こし（faster-whisper）** | ✅ 実装済み（[transcribe.ts](../packages/media/src/transcribe.ts)）。実音声で検証済み（[記録](./measurements/whisper-model-comparison.md)） |
| 同期モード（preserve / common） | ✅ 実装済み |
| **プロジェクトデータモデル** | ✅ 実装済み（[project.ts](../packages/core/src/project.ts)） |
| **解析／AI／人間修正の3レイヤー分離** | ✅ 実装済み（[resolve.ts](../packages/core/src/resolve.ts)） |
| **プロジェクトJSONの保存・読み込み** | ✅ 実装済み（[project-store.ts](../packages/core/src/project-store.ts)） |
| **AIプロバイダー共通インターフェース** | ✅ 実装済み（[provider.ts](../packages/ai/src/provider.ts)） |
| **APIコスト推定・上限・キャッシュ** | ✅ 実装済み（[cost.ts](../packages/ai/src/cost.ts)） |
| **ローカルモード（API不要）** | ✅ 実装済み（[local-provider.ts](../packages/ai/src/local-provider.ts)） |
| **ショート候補の一次抽出** | ✅ 実装済み（[short-candidates.ts](../packages/editing/src/short-candidates.ts)） |
| **解析オーケストレーション（packages/pipeline・15工程）** | ✅ 実装済み・実機（ffmpeg+whisper）で動作確認済み（[docs/14-pipeline.md](./14-pipeline.md)） |
| **CLI（npm run pipeline）** | ✅ 実装済み・実機確認済み（通常出力／--json-progress／部分実行／キャッシュ） |
| **Electron + React（デスクトップアプリ）** | ✅ 実装済み・実機確認済み（解析の選択→開始→進捗→中止→完了。解析は別プロセスで実行） |
| **プロジェクト一覧・新規作成・素材登録** | ✅ 実装済み・実機確認済み（一覧は参照情報のみ保存。**素材は読むだけで移動・コピーしない**） |
| **確認画面：字幕**（確認・修正・部分再出力） | ✅ 実装済み・実機確認済み。⚠️ タイムコード編集は未対応。話者の修正は成果物へ未反映（Premiere実機検証待ち） |
| **確認画面：ショート候補**（採否・タイトル・投稿文・部分再出力） | ✅ 実装済み・実機確認済み。⚠️ 区間の編集は未対応。⚠️ **再解析すると採否が外れる**（IDが時刻を持たない仕様。画面で常時警告） |
| 確認画面：カメラ切替 | ⏳ 未着手（**次の実装**） |
| 確認画面：マーカー / 孤立修正の再接続UI | ⏳ 未着手 |
| 書き出し画面 / AI設定（Gemini・OpenAI本接続） | ⏳ 未着手 |

## ロードマップ（GUI）

| Step | 内容 | 状態 |
|---|---|---|
| 1 | 土台整理（workspace import・ビルド） | ✅ 完了 |
| 2 | Electron骨組み + IPC（解析の実行・進捗・中止） | ✅ 完了 |
| 3 | 確認画面：字幕 | ✅ 完了 |
| 4 | 字幕ID重複の解消 | ✅ 完了 |
| 5 | プロジェクト一覧・新規作成・素材登録 | ✅ 完了 |
| 6 | **確認画面：ショート候補**（採否・編集・shorts.csv 再出力） | ✅ 完了（`7e37d07`） |
| 7 | **確認画面：カメラ切替** — ★次に着手 | ⏳ 未着手 |
| 8 | 書き出し画面 | ⏳ 未着手 |
| 9 | AI設定（ローカルモード配線 → GeminiProvider） | ⏳ 未着手 |

Step 7（カメラ切替）は `edits.cameraShots` が `overrides` / `inserted` / `deletedIds` の3構造で、字幕・ショートより複雑です。着手前に CURRENT-STATE.md の「10. 今後のリファクタリング候補」を確認してください（3画面目が共通化の判断に最も適したタイミングです）。

> 実装の進捗・詳細・未検証事項は [CURRENT-STATE.md](./CURRENT-STATE.md) が唯一の正です。
> ⚠️ 本ファイルの「Phase 1/2/3」と「Step 1〜9」は**別の区分**です。
> Phase は機能範囲の段階（[08-mvp-and-steps.md](./08-mvp-and-steps.md)）、Step は実装した順番を指します。
