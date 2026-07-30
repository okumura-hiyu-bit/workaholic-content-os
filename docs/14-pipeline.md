# 14. パイプライン（オーケストレーション層）

`packages/pipeline` は、個別に実装済みの解析処理（`packages/editing`・`packages/media`）を
「1つのプロジェクト解析フロー」として実行・停止・再開できるようにする層です。

**React / Electron / DOM に一切依存しません。** CLI（`cli/src/pipeline.ts`）からも、将来のElectronメインプロセスからも、`runPipeline()` を呼ぶだけで同じ結果になります。実際に本ドキュメントの内容はすべて実素材（ffmpeg合成音声・faster-whisper large-v3）でのCLI実行によって検証済みです。

---

## 14.1 15工程と依存関係

```ts
type PipelineStepId =
  | 'validate-project'        // ① プロジェクト検証
  | 'probe-media'              // ② 素材情報取得
  | 'extract-audio'            // ③ 音声抽出
  | 'sync-media'                // ④ 音声同期
  | 'correct-audio'             // ⑤ 音声補正
  | 'transcribe'                // ⑥ 文字起こし
  | 'detect-speakers'           // ⑦ 話者判定
  | 'generate-subtitles'        // ⑧ 字幕生成
  | 'generate-chapters'         // ⑨ チャプター生成
  | 'generate-camera-plan'      // ⑩ カメラ切替案生成
  | 'generate-markers'          // ⑪ マーカー生成
  | 'extract-short-candidates'  // ⑫ ショート候補の一次抽出
  | 'generate-premiere-xml'     // ⑬ Premiere用XML生成
  | 'save-artifacts'            // ⑭ 成果物の保存
  | 'save-project';             // ⑮ プロジェクトJSONの更新（検証のみ。実際の保存はオーケストレーターが行う）
```

```
validate-project
  └ probe-media
      └ extract-audio
          ├ sync-media ── detect-speakers ─┬─ generate-camera-plan ──────────┐
          ├ correct-audio ─────────────────┼───────────────────────────────┐│
          └ transcribe ─┬─ generate-subtitles ───────────────────────────┐ ││
                         ├─ generate-chapters ─┬─ generate-markers ───────┤ ││
                         │                     └─ extract-short-candidates│ ││
                         └─────────────────────────────────────────────  │ ││
                                                                          ▼ ▼▼
                                                          generate-premiere-xml
                                                                    │
                                                            save-artifacts
                                                                    │
                                                             save-project
```

**ご提示の依存関係をそのまま採用**しています（字幕は文字起こしに依存／カメラ切替案は同期と話者判定に依存／XMLは同期・字幕・マーカー・カメラ切替案に依存）。加えて実装上必要な2点を追加しました。

1. `generate-premiere-xml` は `correct-audio` にも依存します。非破壊の補正音トラック（ミュート・別ファイル）をXMLに含めるため、補正音の実体が先に存在している必要があるためです。
2. `generate-markers` は `correct-audio` にも依存します。`checks`（要確認事項）は correct-audio と generate-markers の両方が書き足すフィールドで、後者が前者の出力を読んでから自分の分を足し込む構造にしているためです（14.4参照）。

`syncMode`（preserve/common）は `sync-media` ではなく `generate-premiere-xml` の設定として扱います。オフセット自体はモードに関係なく同じ値になるため、モード変更だけでは同期の再計算が不要という判断です（14.6参照）。

---

## 14.2 進捗通知

```ts
interface ProgressEvent {
  stepId: PipelineStepId;
  stepLabel: string;           // 日本語ラベル
  stepIndex: number; stepCount: number;
  overallRatio: number;        // 0〜1
  stepRatio?: number;          // 工程内進捗（extract-audio等、複数素材を処理する工程のみ）
  status: PipelineStepStatus;
  startedAt?: string; elapsedMs?: number;
  warning?: string; error?: PipelineError; message?: string;
}

type PipelineStepStatus =
  | 'pending' | 'running' | 'completed' | 'warning'
  | 'failed' | 'skipped' | 'cancelled';
```

`RunPipelineOptions.onProgress` にコールバックを渡すと、工程ごとに呼ばれます。CLIは `--json-progress` でこれをそのまま1行1JSONとして標準出力します。

---

## 14.3 キャンセル

`RunPipelineOptions.signal`（`AbortSignal`）を渡します。

- **ffmpeg・faster-whisper**：`packages/media/src/process.ts` の `runProcess()` が `spawn(..., { signal })` で子プロセスを起動します。中止されると即座にSIGTERMで停止します。これを実現するため、今回 `correctAudio()` と `transcribe()` を**同期関数から非同期関数に変更**しました（元々 `execFileSync`/`spawnSync` を使っており、外部からの中断ができなかったため）。
- **Node.jsの解析処理**（純粋関数のループ等）：`checkAborted(signal)` を処理の合間に呼び、中止されていれば即座に例外を投げます。
- **将来のAPI処理**：`AiProvider` インターフェースの各メソッドに `signal` を渡す拡張余地を残しています（本タスクでは未接続）。

中止時、**実行中だった工程は `cancelled`**、開始前の工程は触れません。**プロジェクトJSONや人間の修正は破損しません**——実際の保存は工程の成否に関わらず実行の最後に必ず1回だけ行われるためです（14.7参照）。

### 一時生成物の区別

- `temp/`：★削除可能。**実行のたびに必ず空にします**（前回の中断で残った半端なファイルを再利用しない）。
- `cache/`：再実行時に再利用可能。抽出音声・波形・補正音など、原音＋設定から再現できるものだけを置きます。

---

## 14.4 再開・キャッシュ方式

各工程の実行記録は `Project.pipeline.steps[stepId]`（`StepRecord`）に保存されます。

```ts
interface StepRecord {
  status: PipelineStepRunStatus;
  inputHash?: string; configHash?: string; outputHash?: string;
  startedAt?: string; finishedAt?: string; durationMs?: number;
  warnings: string[];
  errorCode?: string; errorMessage?: string;
  toolVersions?: Record<string, string>;
  outputFiles?: string[];
  timings?: Record<string, number>;
}
```

**ハッシュの連鎖**が再開・部分再実行の核です。

- `validate-project` / `probe-media` … 素材ファイルの**サイズ＋更新時刻**から直接算出（`fs.statSync`）
- それ以外の工程 … **依存する工程の `outputHash`** だけから算出（`hashFromDependencyOutputs`）

これにより、上流の出力が変われば下流のハッシュが自動的に連鎖して変わります。**素材の内容は読みません**（動画は数十GBありうるため）。同名・同サイズ・同時刻のまま中身だけ差し替えられた場合は検知できないという割り切りで、GUIには常に「最初から再解析」の選択肢を残す設計です。

**スキップの判定**：`force` 指定が無く、記録の `status` が `completed`/`warning` で、`inputHash`/`configHash` が現在の計算値と一致すれば `skipped`。1つでも変われば再実行します。

**実機で確認済み**：15工程すべてを1回実行後、無変更で再実行すると全工程が数ミリ秒でスキップされます（文字起こしの15秒を含む）。

---

## 14.5 部分実行

```ts
runPipeline(project, { fromStep: 'transcribe', toStep: 'generate-premiere-xml' });
runPipeline(project, { onlySteps: ['generate-subtitles', 'generate-premiere-xml'] });
runPipeline(project, { force: true });               // 計画内すべて強制
runPipeline(project, { force: ['transcribe'] });      // 指定工程だけ強制
```

`onlySteps` は依存工程を自動追加しません。計画外の依存が未完了なら `DEPENDENCY_NOT_COMPLETED` エラーで**実行前に**止まります（実機で確認済み）。

---

## 14.6 素材変更・設定変更の影響範囲（実測）

`run-pipeline.test.ts` でフェイク工程を使い、以下をテストで固定しています。

| 変更 | 再実行される工程 | 再実行されない工程 |
|---|---|---|
| 素材ファイルの中身 | `validate-project` 以降**すべて** | — |
| `syncMode`（preserve↔common） | `generate-premiere-xml`・`save-artifacts`・`save-project` のみ | `sync-media`・`detect-speakers`・`generate-camera-plan` |
| 文字起こしモデル（large-v3→medium） | `transcribe`・`generate-subtitles`・`generate-chapters`・`extract-short-candidates`・下流 | `sync-media`・`detect-speakers`・`generate-camera-plan` |

**syncModeの扱いは設計判断です。** オフセット自体はモードに関係なく同じ値になるため、モード変更のたびに同期解析（数秒〜十数秒）をやり直すのは無駄と判断し、XML組み立て工程の設定として切り出しました。

---

## 14.7 人間修正の保護

再解析結果の保存は、必ず **`resolveProject(analysis, edits)`**（`packages/core/src/resolve.ts`、前タスクで実装済み）を経由してから書き出します。

```ts
interface ResolveDiffReport {
  reconnected: ReattachedEditReport[]; // IDがずれたが時刻の近さで再接続できた修正
  orphaned: OrphanedEditReport[];      // 接続先が見つからなかった修正（★内容は保持）
  conflicted: ConflictedEditReport[];  // 同じ要素だが解析側の中身が変わった（人間の修正を優先適用）
  added: string[];                     // 新しく増えた解析項目
  removed: string[];                   // 消えた解析項目
}
```

`RunPipelineResult.resolveDiff` として毎回返されます。**競合時にAI結果を自動採用することはありません**——`resolveProject` は常に人間の修正値を優先し、`conflicted` はあくまで「解析側の前提が変わったので確認したほうがよい」という通知です。

実機・フェイク両方のテストで確認済み：ショート候補が再解析で入れ替わり、以前の採用判断の接続先が無くなった場合も、その判断内容（`adopted: true, title: "..."`）は消えず `orphaned` として報告されます。

---

## 14.8 ログ形式

`logs/run-<timestamp>.jsonl` に1行1JSONで記録します。

```ts
interface LogEntry {
  at: string; stepId: PipelineStepId; event: 'start'|'finish'|'warning'|'error';
  durationMs?: number;
  inputFileNames?: string[];  // ★basenameのみ。フルパスも内容も含まない
  success?: boolean; warningCount?: number; errorCode?: string;
  toolVersions?: Record<string, string>;
}
```

**この型に無いフィールドは書き込めません。** APIキー・音声内容・字幕全文・文字起こし全文を渡すフィールド自体が存在しないため、実装ミスで紛れ込むことを型レベルで防いでいます。

---

## 14.9 エラー形式

```ts
interface PipelineError {
  code: string; stepId: PipelineStepId;
  userMessage: string; technicalMessage?: string;
  recoverable: boolean; suggestedAction?: string;
}
```

`packages/pipeline/src/errors.ts` に想定エラー（ffmpeg/Python/faster-whisper未検出、素材欠落、音声トラック無し、同期信頼度低下、ディスク容量不足、権限無し、XML生成失敗、ユーザー中止、依存工程失敗・未完了、パス脱出、不正なプロジェクト）をファクトリ関数として用意しています。

---

## 14.10 文字起こしの工程別処理時間（実測）

`scripts/transcribe.py` に計測を追加しました。実機（7.5秒の日本語音声・large-v3・int8・Apple Silicon）：

| 内訳 | 時間 |
|---|---|
| モデル読み込み | 約2.6〜2.7秒（固定・呼び出しのたびに発生） |
| 音声前処理（デコード・特徴量・言語検出） | 約0.02秒 |
| **推論（実際のデコード）** | **約6.4〜6.8秒**（音声尺の0.85〜0.9倍） |
| 後処理・JSON変換 | 無視できるほど小さい |

**前回「7.5秒の音声に9.6秒」と報告した内訳が判明しました。** 支配的なのはモデル読み込みではなく推論そのもの（全体の約70%）で、**推論の実時間倍率は0.85〜0.9倍**（ほぼリアルタイム）です。10分素材なら、モデル読込の固定約2.7秒＋推論約8.5〜9分で、**合計は当初の悲観的な見積り（13分）より短い約9分**という計算になります（実測は7.5秒素材からの外挿であり、10分素材そのものでの実測ではない点に注意）。

---

## 14.11 ディレクトリ構成（実装済み・実機で確認）

```
project/
├── project.json
├── media/                    元素材の既定置き場（任意。絶対パス参照が基本）
├── cache/                    ★再実行時に再利用可能。消しても作り直せる
│   ├── audio/                 抽出音声・corrected/ に非破壊の補正音
│   ├── waveform/               音量エンベロープ（.json + .f32）
│   ├── transcription/          （将来の文字起こしキャッシュ用に予約）
│   └── analysis/               （将来の中間解析キャッシュ用に予約）
├── exports/                  ★ユーザー成果物。パイプラインは削除しない
│   ├── premiere/                <id>.fcp7.xml
│   ├── subtitles/                subtitle.srt / speaker.srt / emphasis.srt
│   ├── chapters/                  youtube-chapters.txt
│   ├── shorts/                     shorts.csv
│   └── reports/                     report.html
├── logs/                     run-<timestamp>.jsonl
└── temp/                     ★削除可能。実行のたびに空にする
```

---

## 14.12 セキュリティと安全性（実装内容）

| 要件 | 実装 |
|---|---|
| 入力パスを絶対パスへ解決 | `buildProjectPaths()` が常に `resolve()` を通す |
| プロジェクト外への書き込み防止 | `resolveWithinProject()` が `../` 等での脱出を拒否（テスト済み） |
| シェル文字列を組み立てない | すべて `spawn(cmd, args[])` の配列形式。`shell: true` は使わない |
| 日本語・空白・記号のファイル名 | 実機で確認済み（プロジェクトディレクトリ名・素材名とも日本語＋空白で実行成功） |
| 元素材を上書きしない | `correctAudio()` の `assertNonDestructive()` が入力＝出力を実行前に拒否。実機でMD5不変を確認 |
| 出力ファイルの衝突 | `writeManagedArtifact()` — 自分が過去に書いたと記録があるファイルは上書き、無ければ `collisionSafePath()` で退避 |
| APIキーをプロジェクトJSONに保存しない | `AiProvider`（前タスク実装）は環境変数／将来はOSキーチェーン参照のみ |

---

## 14.13 CLI

```bash
npm run pipeline -- --project "/absolute/path/to/projectDir"
npm run pipeline -- --project ".../project.json" --from transcribe --to generate-premiere-xml
npm run pipeline -- --project "..." --force
npm run pipeline -- --project "..." --force transcribe,generate-subtitles
npm run pipeline -- --project "..." --sync-mode common
npm run pipeline -- --project "..." --model medium
npm run pipeline -- --project "..." --json-progress
npm run pipeline -- --help
```

`Ctrl+C` で `AbortController` を発火させ、安全に中止します。終了コードは `0`（成功）／`1`（失敗あり）／`130`（中止）。
