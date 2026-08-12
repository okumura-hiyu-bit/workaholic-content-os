# CURRENT STATE — 引き継ぎドキュメント

> 作成日: 2026-07-30 / 最終更新: 2026-08-09（Step 1「土台整理」、Step 2「Electron骨組み + IPC」、Step 3「確認画面：字幕」、Step 4「字幕ID重複の解消」、Step 5「プロジェクト一覧・新規作成・素材登録」、Step 6「確認画面：ショート候補」、Step 7「確認画面：カメラ切替」、Step 8「確認画面：マーカー」、Step 9「共通化リファクタリング」、Step 10「復旧画面（Review Recovery）」を反映）。この内容は会話の要約ではなく、**実際のリポジトリ・テスト結果・型チェック結果を根拠に**作成しています。数値は必ず次回セッション側でも再確認してください（本ファイル末尾のコマンド）。
>
> **Step 1〜10はすべてコミット済み**（最新: `e95c8f1`）。ワーキングツリーに未コミットの実装は残っていません。
> リポジトリはブランチ `main`、リモート `origin`（https://github.com/okumura-hiyu-bit/workaholic-content-os）へpush済みです。
> テストは **52ファイル / 1455件** 全pass、型チェック エラー0件、ビルド成功。

---

## 1. プロジェクトの目的

**WORKAHOLIC Content OS** は、動画編集ソフトではなく、**Premiere Proを開く前の準備を完了させるローカル中心のAIアシスタントエディター**です。

- **Premiere Proを置き換えません。** 最終的な演出・テンポ調整・細かな編集は常にPremiereで行います。
- 本システムが担うのは「準備・整理・反復作業」——素材の同期、文字起こし、字幕、話者名、カメラ切替の初回組み、ショート候補探し、非破壊の音声補正、Premiere用XML・SRT・チャプター・レポートの生成です。
- 目標は「Premiereを開いた時点で編集作業の90%が完了している状態」。編集者は演出・ストーリー・テンポ・感情表現に集中する。
- 処理はできる限りローカルで完結させ、APIは「文章理解・候補評価」など必要な箇所（ショート候補の順位付け・タイトル案・概要欄・投稿文・要約・チャプター名改善）に限定する設計。API本接続（Gemini/OpenAI）は**未実装**（後述）。
- 固定費0円を基本方針とし、上限金額・キャッシュ・ローカルモードでのコスト管理を前提に設計している。

---

## 2. 現在のアーキテクチャ

モノレポ構成（npm workspaces）。`package.json` の `workspaces`: `["packages/*", "workers/*", "cli", "apps/*"]`。

```
packages/core      … データモデル・状態遷移・投稿可否判定・プロジェクトの永続化（単一の正）
packages/media      … ffmpeg/ffprobe連携・非破壊の音声補正・文字起こし・キャンセル可能な子プロセス実行
packages/editing     … 素材解析の純粋ロジック（同期・話者判定・カメラ切替・字幕・FCP7 XML・ショート候補）
packages/ai           … AIプロバイダー共通インターフェース・コスト管理・ローカルモード（本接続は未実装）
packages/pipeline       … 15工程のオーケストレーション（実行・進捗・キャンセル・再開・キャッシュ）
cli                       … 上記を呼び出すだけのターミナル入口（selfcheck / verify-fcp7 / pipeline）
scripts                    … Pythonブリッジ（faster-whisper呼び出し）
docs                         … 設計ドキュメント一式（01〜14 + measurements/ + archive/）
workers/feed                  … （関連プロジェクト）ポッドキャストRSS配信Worker。Content OS本体とは別関心
apps/desktop                   … ★Electronアプリ（Main / Preload / Renderer / Shared / 解析専用プロセス）
tsup.config.ts                  … Electronメインプロセス向けのビルド定義
dist/                            … ★ビルド生成物。.gitignore済み（Git管理対象外・手で編集しない）
```

`apps/desktop` の内訳：

```
apps/desktop/src/
├── shared/    … Main・Preload・Rendererが共有する型と契約（DTO / IPCチャンネル / 入力検証 / 工程一覧）
├── main/      … ウィンドウ生成・IPC・実行管理（排他）・projectRoot解決・構造化ログ
├── preload/   … contextBridgeで最小APIだけを公開
├── renderer/  … React。状態遷移は純粋なリデューサに分離してテストする
└── worker/    … ★解析専用プロセス。dist/pipeline.js を動的importして runPipeline() を実行
```

### 依存方向（★一方向。これを崩さない）

```
cli/pipeline.ts ─────────────────┐
                                  ├→ packages/pipeline → packages/{editing, media, ai} → packages/core
apps/desktop（解析専用プロセス）─┘
   ※ 解析専用プロセスは静的importではなく、実行時に dist/pipeline.js を動的importする

apps/desktop/main → @contentos/core（project.json の読み書きのみ）
```

- `packages/core` は他のどのpackageにも依存しない（末端）。ただし `packages/core/src/project.ts` だけは `packages/editing` を参照する例外的な逆依存を持つ（`build-project.ts` の型 `SyncMode`、および `types.ts` の `CameraShot`・`Speaker`・`Word` 等7つ）。いずれも `import type` のみで、ロジック依存ではない。
- `packages/pipeline` は React・Electron・DOM を一切importしない（`packages/pipeline/src/index.ts` のコメントに明記）。CLIからもElectronの解析専用プロセスからも同じ関数（`runPipeline()`）を呼ぶだけで完結する。
- `packages/ai` は現状どの実行フローからも呼ばれていない（コスト管理・ローカルモードの型とロジックのみ実装済み。パイプラインへの配線は未実施）。

### パッケージ間の参照方法（★2026-08-01 変更。GUI着手前の土台整理）

パッケージをまたぐ参照は **workspace import（`@contentos/*`）に統一**した。以前の相対パス越境（`'../../core/src/project.ts'`）は全廃してある。

```ts
// ✅ 現在の書き方
import type { Project } from '@contentos/core/project';
import { renderSrt } from '@contentos/editing/srt';
import { runPipeline } from '@contentos/pipeline';

// ❌ 以前の書き方（もう存在しない。復活させないこと）
import type { Project } from '../../core/src/project.ts';
```

- 同一パッケージ内の参照は従来どおり相対パス＋`.ts`拡張子（`'./diff-report.ts'`）のまま。**変えるのはパッケージをまたぐときだけ。**
- 各 `package.json` の `exports` には**実際に他パッケージから使われるモジュールだけ**を列挙している。未公開のサブパスへのディープimportは型・実行時の両方で失敗する（`tsc: TS2307` / `node: ERR_PACKAGE_PATH_NOT_EXPORTED`）。**依存の向きが規約ではなく構造で守られている**ので、新しい参照を足したくなったら `exports` に追加してから使うこと。
- `dependencies` は実際の依存に合わせて宣言済み（循環なし）。

```
editing → （依存なし）
core / media / ai → editing（いずれも型のみ）
pipeline → core, editing, media
cli → core, editing, media, pipeline
feed-worker → core
```

### ビルド（Electronメインプロセス向け）

CLIは `node --experimental-strip-types` でTypeScriptを直接実行できるが、**Electronのメインプロセスではこの方法が使えない**。そのため `tsup` で通常のJavaScriptに変換したものを `dist/` に出力する。

```bash
npm run build     # tsup。dist/ に出力
npm run verify    # typecheck → test → build をまとめて実行
```

| 出力 | 中身 |
|---|---|
| `dist/pipeline.js` + `.d.ts` | `runPipeline()` ほか。CLIとGUIが共用する唯一の解析入口 |
| `dist/core.js` + `.d.ts` | プロジェクトの読み書き・3レイヤー統合（確認画面が使う） |
| `dist/chunk-*.js` | 上記2つの共有部分。coreが二重に入らないよう切り出したもの |

- **形式はESMのみ**（`packages/*` はすべて `"type": "module"` のため）。CJSが必要になったら `tsup.config.ts` の `format` に追加する。
- **`dist/` は生成物。`.gitignore` 済みでGit管理対象外**。手で編集せず、必要なときに `npm run build` で作り直す。
- `tsup.config.ts` がビルドを3パスに分けているのは、複数entryと `.d.ts` 生成を1パスで行うと tsup が宣言のロールアップに失敗するため（entry単体なら成功する）。理由は設定ファイル内のコメントに記載。
- **型は `dist/` ではなくソースから解決される。** `tsc` は `exports` 経由で `packages/*/src/*.ts` を直接読むため、`npm run typecheck` と `npm test` にビルドは不要（`dist/` が無くても通る）。`dist/` が要るのは「型ストリッピングなしで実行する」場面だけ。

### ★projectRoot の扱い（Electron実装で最も重要な判断）

`scripts/transcribe.py` と `.venv` のパスは `packages/media/src/transcribe.ts` で **`opt.projectRoot ?? process.cwd()`** から解決している。CLIはリポジトリルートで実行されるため `process.cwd()` で足りていたが、**Electronアプリのcwdはリポジトリルートではない**。

**採用した方式：解析専用プロセスの cwd をリポジトリルートに固定する。**

1. Electron Main が `apps/desktop/src/main/project-root.ts` でリポジトリルートを解決する（環境変数 `CONTENTOS_PROJECT_ROOT` → パッケージ時の resources → `app.getAppPath()` から上へ探索。**`process.cwd()` は一切読まない**）。
2. `child_process.fork` の `cwd` にその値を渡す（`main/analysis-process.ts`）。
3. 併せて環境変数 `CONTENTOS_PROJECT_ROOT` と start メッセージの `projectRoot` にも同じ値を入れる。

**なぜ `RunPipelineOptions` 経由で渡さないのか（★重要）**

`runPipeline()` の設定に `projectRoot` を足すのが素直に見えるが、`TranscribeConfig` に項目を足すと `stepConfigSlice('transcribe')`（`packages/pipeline/src/registry.ts`）が `config.transcribe` を丸ごとキャッシュキーに使っているため、**transcribe工程のキャッシュキーが変わる**。結果として CLI（projectRoot未指定）と GUI（指定あり）でキャッシュを共有できなくなり、一番重い文字起こしが両者で二重に走る。これは凍結対象の「キャッシュ方式」の変更にあたるため採用しなかった。

cwd固定なら `packages/*` を一切変更せずに同じ結果が得られる。実際に、GUIで解析したプロジェクトに対して CLI を実行すると**全工程がキャッシュヒットする**ことを確認済み（後述の実機確認⑩）。

なお `import.meta` はコード全体で未使用のため、バンドルしてもモジュール位置に依存したパス解決が壊れることはない（確認済み）。

### Electron の構成（2026-08-01 追加）

**★解析は必ず別プロセスで動かす。** `computeEnvelope` / `estimateOffset` / `syncSources` は同期のCPU集約処理で、ffmpeg・whisperと違って子プロセスに逃げない。メインプロセスで `runPipeline()` を直接呼ぶとウィンドウが固まる。

**採用方式：`child_process.fork`（Electronのバイナリを `ELECTRON_RUN_AS_NODE=1` でNodeとして起動）**

`utilityProcess` ではなく fork を選んだ理由：

| 観点 | fork（採用） | utilityProcess |
|---|---|---|
| ESM | `dist/pipeline.js`（ESM）を動的importできる | Electronのバージョン依存 |
| テスト | 起動関数を差し替えてElectron無しで検証できる（★今回のテスト要件の前提） | Electronランタイム内でしか存在しない |
| Node依存 | Electron同梱のNodeで動く。利用者のマシンにNode不要 | 同左 |
| 終了時の後始末 | `before-quit` で明示的に kill（`disposeAll`） | Electronが管理 |

唯一の弱点（Electron側でのライフサイクル自動管理）は、アプリ終了時の明示的な kill で代替している。

**プロセスの責務**

| 層 | 責務 | してはいけないこと |
|---|---|---|
| Main | ウィンドウ生成・IPC受付・入力検証・排他・projectRoot解決・構造化ログ | `runPipeline()` を直接実行しない |
| Preload | `contextBridge` で36個のAPIだけを公開 | `ipcRenderer` / `fs` / `child_process` を渡さない |
| Renderer | 表示と操作。状態遷移は純粋なリデューサ | Nodeの機能に触れない（tsconfig.web.json が `types: []` で防ぐ） |
| 解析専用プロセス | `dist/pipeline.js` を動的importして `runPipeline()` を実行 | `packages/*` を相対パスでimportしない |

**Rendererへ渡さないもの**：`technicalMessage`・stack trace・`Error`オブジェクト・`AbortSignal`・関数・APIキー・文字起こし全文・字幕全文。`PipelineError` は `shared/errors.ts` の `toSafeError()` で `SafePipelineError` に落としてから送る。開発者向け情報は `main/logger.ts` の構造化ログにのみ残す。

**二重実行の防止**：`run-pipeline.ts` は変更していない。`main/run-manager.ts` が実行中プロジェクトの `Set` と runId の `Map` を持ち、UIの `disabled` に依存せずMain側で開始要求そのものを拒否する。同じprojectIdなら `PROJECT_ALREADY_RUNNING`、別プロジェクトなら `ALREADY_RUNNING`。中止完了まで再実行不可。解析プロセスが異常終了した場合も `onExit` で必ずロックを解放する。

### プロジェクト一覧・新規作成・素材登録（2026-08-04 追加）

実運用の入口。**新規案件を作る → 素材を登録する → 役割を決める → 解析へ進む** までをGUIで完結させる。

**★プロジェクト一覧は「参照情報だけ」を持つ。**
プロジェクト本体は中央DBへ移さない。アプリ設定（`app.getPath('userData')/projects.json`）が持つのは
`projectPath` と `lastOpenedAt` の2つだけで、案件名・ステータス・素材数・更新日時は**毎回 project.json から読み直す**。
CLIで更新した内容もそのまま一覧に反映され、一覧とプロジェクト本体がズレない。ローカル完結・固定費0円。

| 関心事 | 実装 |
|---|---|
| 一覧の保存・読み出し | `apps/desktop/src/main/project-registry.ts` |
| 新規作成 | `apps/desktop/src/main/project-create.ts` |
| 素材登録・役割設定・解析前チェック | `apps/desktop/src/main/assets.ts` |
| DTO・検証 | `apps/desktop/src/shared/setup-dto.ts` / `setup-validate.ts` |
| 画面 | `apps/desktop/src/renderer/SetupScreen.tsx` + `setup-state.ts` |

**新規作成**：`@contentos/core` の `createProject()` が返した構造をそのまま使い、出演者と `syncMode` だけを載せて保存する。
`analysis` は作らず（解析前なので存在しない）、`edits` は初期構造のまま。
案件フォルダは `<保存場所>/<収録日>_<案件名>` で、**既存フォルダがあれば連番を付けて絶対に上書きしない**。
出演者の記号（A / B / C）が `Speaker.id` になり、素材の役割（`mic_A`・`cam_A`）と対応する。

**★素材は読むだけ。移動・コピー・上書きを一切しない。**
project.json に絶対パスと ffprobe のメタデータを保存し、元のファイルには触れない（実機でMD5一致を確認済み）。

**★自動推測した役割のまま解析させない。**
ファイル名から役割を推測するが `roleConfirmed: false` を立て、**未確定の素材が1つでもあれば解析開始をエラーで止める**。
人が役割を選ぶと確定になる（判断は `assets.ts` の `updateAsset` が持ち、検証層は構造だけを見る）。

**★「解析に使わない」素材は `project.assets` から外す。**
パイプラインは `project.assets` を全部使うため、外さないと「無効にしたのに解析される」ことになる。
捨てずに `project.disabledAssets`（`migrateProject` が未知フィールドを保持する性質を利用）へ退避し、いつでも戻せる。

**解析前チェック**：`error`（解析開始不可）と `warning`（人が確認して続行可）を分ける。

| severity | 内容 |
|---|---|
| error | 素材なし / 基準映像なし / 音声付き素材なし / 役割未確定 / ファイル欠落 / 読み取り不可 / 重複登録 / 書き込み不可 |
| warning | 出演者のマイク・カメラ未登録 / fps不一致 / 尺の大幅な差 / 空き容量不足 / 映像も音声も無い素材 / 解析済みプロジェクトの素材変更 |

### 確認画面（Review）— 字幕（2026-08-03 追加）

**★人間の修正は `project.edits` にだけ書く。`project.analysis` は絶対に触らない。**
表示値は自作せず `resolveProject()` に作らせ、履歴は `recordEdit()` で残す。保存は `saveProject()`（一時ファイル→rename）に任せる。

| 関心事 | 実装 |
|---|---|
| データ組み立て・保存 | `apps/desktop/src/main/review.ts` |
| 入力検証 | `apps/desktop/src/shared/review-validate.ts` |
| DTO | `apps/desktop/src/shared/review-dto.ts` |
| 再生用プレビュー | `apps/desktop/src/main/media.ts` |
| 画面 | `apps/desktop/src/renderer/ReviewScreen.tsx` + `review-state.ts` |

**競合更新の防ぎ方**：読み込み時の `updatedAt` を `expectedUpdatedAt` として保存要求に載せ、Main が保存直前に現在値と照合する。食い違えば**上書きせず**「プロジェクトが別の処理で更新されました。再読み込みしてください」を返す。`saveProject` が保存のたびに `updatedAt` を更新するので、古い値での連続保存も同じ経路で弾かれる。

**競合の検出方法（実行時の diff とは別物）**：`buildResolveDiffReport`（パイプライン）は再解析前後の解析結果を比べるが、その結果は project.json に残らない。確認画面を開く時点では旧解析が無いため、`recordEdit` が残した履歴の `before`（修正した時点の解析値）を現在の解析値と比べて競合を出す。

**再出力**：`generate-premiere-xml` → `save-artifacts` → `save-project` の3工程だけを `onlySteps` + `force` で実行する（工程はMainが固定し、Rendererに選ばせない）。`force` が要るのは、キャッシュキーが素材と設定から作られ **`project.edits` を含まない**ため。付けないと「変更なし」でスキップされ、修正が成果物に出ない。解析・文字起こし・同期は再実行しない。

**再生用プレビュー**：4K素材を再生せず、`cache/preview/<assetId>.m4a`（AAC・モノラル・32kHz・64kbps指定）を生成して使う。元素材は読むだけで変更しない。Rendererには絶対パスを渡さず、`contentos-media://<token>` だけを渡す。tokenからパスへの変換は Main のレジストリだけが知り、**未登録トークンは404**になる。

**★今回の制限（画面にも明記済み）**
- **タイムコード編集は未対応。** `SubtitleEdit`（`packages/core`）が `text` / `speakerId` / `deleted` しか持たず、時刻を適用するには凍結対象の `resolve.ts` の変更が必要になるため。要求が来たら黙って無視せず検証で拒否する。
- **話者の修正は成果物に反映されない（★Premiere実機検証が終わるまで保留）。** `project.edits` には保存され画面にも出るが、`subtitle.srt` は本文のみを使い、`speaker.srt` は `analysis.speech`（発話区間）から作られるため。反映には `save-artifacts.ts`（成果物の中身）の変更が必要で、検証前に出力形式を動かすと検証のやり直しになる。本文の修正は `subtitle.srt` に反映される（実機で確認済み）。

### 確認画面（Review）— ショート候補（2026-08-04 追加 / Step 6）

字幕Reviewと**同じ設計思想**で、ショート候補の採否・編集・保存を行う。3レイヤー分離・`expectedUpdatedAt` による競合検出・`saveProject()` による原子的保存・`recordEdit()` の履歴は字幕と完全に同じ扱い。**`packages/*` は一切変更していない**（差分はすべて `apps/desktop/` 内）。

| 関心事 | 実装 |
|---|---|
| データ組み立て・保存 | `apps/desktop/src/main/shorts.ts` |
| 入力検証 | `apps/desktop/src/shared/shorts-validate.ts` |
| DTO | `apps/desktop/src/shared/shorts-dto.ts` |
| 画面 | `apps/desktop/src/renderer/ShortsScreen.tsx` + `shorts-state.ts` |
| 再出力の工程固定 | `apps/desktop/src/main/ipc.ts` の `SHORTS_EXPORT_STEPS` |

**★人間の判断は `project.edits.shorts` にだけ書く。`project.analysis` は絶対に触らない。**
実機で保存前後の `analysis` が**文字列レベルで完全一致**することを確認済み。`edits` のうち書き換わるのは `shorts` と `history` だけで、`subtitles` / `cameraShots` / `chapters` / `markers` / `syncOffsets` は初期状態のまま（実機・テスト両方で固定）。

**保存できる項目**：`adopted`（採用 / 不採用 / 未判断）・`title`・`hook`・`caption`・`hashtags`・`note`。いずれも `ShortDecision`（`packages/core`）が既に持つ項目で、**データモデルは変更していない**。

**★再解析でIDが繋がらない（orphaned）— これは仕様**

ショート候補のIDは `short_01` のような**連番で、時刻を含まない**。`resolveProject` は時刻での再接続ができないため、再解析で候補の並びが変わると採否・編集内容は**必ず** `orphaned` になる（`resolve.ts` のコメントに明記されている既存仕様）。実装で回避できないので、次の3つで扱う。

1. 警告文の本体を **Main が持つ**（`shorts.ts` の `REANALYSIS_WARNING`）。DTOに載せて画面に常時表示し、Renderer 側のフラグで消せないようにしている。
2. 孤立した判断は**内容ごと**返す（採否・タイトル・メモまで）。件数だけでは何を失うのか分からないため。
3. **`project.json` からは消さない。** 孤立しても `edits.shorts` に残り続けるので、後から手で戻せる。

**★`rangeChanged`（静かな取り違え）の設計理由**

再解析で候補が入れ替わっても、**IDが残っていれば `orphaned` にならない**。つまり「`short_01` の採否が、中身の違う別区間の `short_01` に付いたまま」という状態が起こりうる。孤立と違って画面に何も出ないぶん、こちらの方が危険。

そこで**最初に判断した時点の区間**（`startSec` / `endSec` / `score`）を `recordEdit` の履歴に `field: 'candidateRange'` として残し、読み込み時に現在の解析値と比較して `rangeChanged` を立てる。

- 履歴は追記のみ・`field` は自由文字列なので、**`EditsLayer` の構造は変えていない**。
- 基準は**最初の1件だけ**。2回目以降の保存で上書きしない（「人が判断したときの状態」を基準にしたいため）。
- 検出しても**判断を自動で取り消さない**。「要確認」として、判断時の区間と現在の区間を並べて提示するに留める。
- ★副作用：`edits.history` が「人の操作の記録」と「システムの内部状態」の2用途を持つことになった。将来 history を人向けに表示する実装では `candidateRange` を除外すること。

**★再出力は `save-artifacts` → `save-project` の2工程のみ（字幕の3工程より狭い）**

`generate-premiere-xml` を**意図的に外している**。ショート候補は FCP7 XML に含まれないため動かす理由がなく、動かせば Premiere実機検証の対象である成果物を無用に作り直すことになる。

`save-artifacts` は `generate-premiere-xml` に依存するが、`onlySteps` は依存を自動追加せず「完了済みであること」だけを求める（`registry.ts` の `computeExecutionPlan` / `assertDependenciesSatisfied`）。したがって**一度フル解析を通したプロジェクトなら、XMLを作り直さずに `shorts.csv` だけを更新できる**。未完了なら `DEPENDENCY_NOT_COMPLETED` で止まる（正しい挙動）。実機で FCP7 XML と `subtitle.srt` の MD5 が再出力前後で不変であることを確認済み。

`force` が要るのは字幕と同じ理由（キャッシュキーが `project.edits` を含まない）。工程はMainが固定し、Rendererに選ばせない。

**★`shorts.csv` に反映される項目 / されない項目**

| | 項目 |
|---|---|
| **反映される** | `adopted`（採用 / 不採用 / 未判断）・`title` |
| **反映されない** | `hook`（冒頭フック）・`caption`（投稿文）・`hashtags`・`note`（メモ） |

`save-artifacts.ts`（凍結対象）が書くのは `id,startSec,endSec,score,adopted,title,signals` の7列だけで、それ以外は `project.json` にのみ残る。変えると成果物の中身が変わるため触っていない。**この制限は画面に明記してある**（`FIELDS_NOT_EXPORTED`）。

**★MainにUI文言を置いている理由**

`REANALYSIS_WARNING`（再解析の警告文）と `FIELDS_NOT_EXPORTED`（CSVに出ない項目名）は日本語の表示文言だが、**あえて Main（`shorts.ts`）に置いている**。どちらも実装で回避できない性質を編集者に知らせるもので、Renderer 側の都合で消したり書き換えたりできてはいけないため。DTOに必ず載せ、画面は表示するだけにしている。

トレードオフとして Main が UI 文言に結合している。文言だけを変えたい場合も Main を直すことになる。

**★今回の制限（画面にも明記済み）**
- **区間（開始・終了時刻）の編集は未対応。** `ShortDecision`（`packages/core`）が時刻を持たず、適用するには凍結対象の `resolve.ts` の変更が必要になるため。要求が来たら黙って無視せず**検証で拒否する**。
- 上記のとおり `hook` / `caption` / `hashtags` / `note` は成果物に出ない。

### 確認画面（Review）— カメラ切替（2026-08-05 追加 / Step 7）

字幕・ショート候補と同じ3レイヤー分離・`expectedUpdatedAt` の競合検出・`saveProject()` の原子的保存・`recordEdit()` の履歴で作る。**`packages/*` は1ファイルも変更していない**（差分はすべて `apps/desktop/` 内）。

| 関心事 | 実装 |
|---|---|
| データ組み立て・保存 | `apps/desktop/src/main/camera.ts` |
| 入力検証 | `apps/desktop/src/shared/camera-validate.ts` |
| DTO | `apps/desktop/src/shared/camera-dto.ts` |
| 画面 | `apps/desktop/src/renderer/CameraScreen.tsx` + `camera-state.ts` |
| 再出力の工程固定 | `apps/desktop/src/main/ipc.ts` の `CAMERA_EXPORT_STEPS` |

**★字幕・ショート候補との決定的な違い（3点）**

**① カメラ修正は FCP7 XML そのものを書き換える。**
`generate-premiere-xml.ts` が `resolveProject()` の `resolved.cameraShots` をそのまま V1 トラックに並べる。`save-artifacts` は `cameraShots` を件数表示（`report.html`）にしか使わないため、**カメラ修正が反映される成果物は FCP7 XML だけ**。字幕（SRT）やショート（CSV）と違い、Premiereプロジェクトの映像トラック構成が直接変わる。

★ただし**変更したのは入力データだけ**で、生成ロジック（`fcp7xml.ts` / `build-project.ts` / `generate-premiere-xml.ts`）は無変更。`resolveProject` を経由して人間の修正を流し込む既存の仕組みをそのまま使っている。

**② カメラIDは時刻を持つ（`shot-<ミリ秒>`）ので再接続が効く。**
ショート候補（連番IDのため再解析で必ず孤立）とは正反対で、`matchEdits` が時刻の近さ（既定±0.5秒）で繋ぎ直す。その結果 **`reattached` が日常的に発生する**。`ResolveResult.reattached` は以前から存在したが、**字幕・ショートでは一度も画面に出していなかった**。カメラでは主役級の情報なので今回初めて DTO に載せた。

「IDが時刻を持たないショートの `rangeChanged`」に相当する仕組みは**カメラには入れていない**。位置が動けば `matchEdits` が `reattached` として明示的に報告するため、同じ問題を別の仕組みで解く必要がないから。

**③ 要素の追加・削除・時間軸の変更を伴う。**
`edits.cameraShots` は `overrides` / `inserted` / `deletedIds` の3構造。字幕・ショートが「1要素に属性を足す」だけだったのに対し、カメラは並び全体が変わる。そのため**保存結果は1要素ではなく並び全体を返す**（隣のカットの重なり・隙間まで変わるため）。

**★整合性を守るのは Main と検証層だけ**

`build-project.ts`（凍結対象）は次の3つを検査しない。放置すると編集者が理由に気づけない壊れ方をするため、**保存前に必ず塞ぐ**。

| 危険な入力 | build-project.ts の挙動 | 対策 |
|---|---|---|
| 存在しない `cameraId` | **`throw new Error('カメラ素材が見つかりません')`** → 再出力ごと失敗 | 「そのプロジェクトに実在する映像素材の role」に限定 |
| `endSec <= startSec` | **`continue` で黙って捨てる** → 保存できたのにXMLに出ない | ゼロ長・逆転を拒否 |
| カット同士の重なり | 検査せず V1 に並べる → Premiereのタイムラインが崩れる | 適用後の並びを組み立てて重なりを検出し拒否 |

加えて「全カット削除」（映像トラックが空になる）と「素材の尺を超えるカット」も拒否する。隙間は**禁止しない**（意図的な間の可能性があるため）が、警告として数える。

**★`cameraId` は `asset.id` ではなく `asset.role`**（`wide` / `cam_A` / `cam_B`）。`generate-premiere-xml.ts` が `videos` を `{ id: a.role }` で組み立てているため。ここを取り違えると即座に XML 生成が例外を投げる。

**★人が追加したカットの扱い**

- **IDは `shot-ins-<ミリ秒>`**。解析側の `cameraShotId()` と衝突しない接頭辞を使う。`packages/core` の `timeFromId()`（`/^[a-z]+(?:-[A-Za-z_]+)?-(\d{8,})(?:-(\d+))?$/`）でも時刻を復元できるので、**core を変更せずに**孤立時の時刻表示と再接続が従来どおり働く。
- **`reason` は `'hold'`（★暫定措置）**。`ShotReason`（`packages/editing/src/types.ts`）は `speech | overlap | laughter | hold | reaction | merged` の閉じた union で、**「人が追加した」を表す値が無い**。この値は FCP7 XML のクリップ名に `(${reason})` として現れるため何かを選ばざるを得ず、「編集者がこのカメラで固定した」意図に最も近い `'hold'` を選んだ。**将来 `ShotReason` に専用の値（`'manual'` 等）を追加できるようになったら差し替える**。差し替え箇所は `camera.ts` の `INSERTED_SHOT_REASON` 1箇所に閉じてある。
- **変更は `overrides` ではなく `inserted` の中身を直接直す。** `overrides` は解析側のIDにしか当たらないため（`resolve.ts` の `matchEdits`）。
- **削除は `inserted` から取り除く**（`deletedIds` には積まない）。

**★再出力は `generate-premiere-xml` → `save-artifacts` → `save-project` の3工程（字幕と同じ）**

ショート候補（2工程・XMLを除外）とは逆で、`generate-premiere-xml` が**必須**。カメラ修正はここにしか出ないため、外すと修正がどこにも反映されない。`force` が要るのは他画面と同じ理由（キャッシュキーが `project.edits` を含まない）。工程はMainが固定し、Rendererに選ばせない。

**★重なり・尺超過が残っているうちは再出力させない。** XMLを作り直す唯一の画面なので、壊れたまま書き出させない（`camera-state.ts` の `canExport`）。隙間だけなら出力できる。

**★Renderer 側でも保存前に整合性を見せる**

字幕・ショートの下書きは他要素に影響しなかったが、カメラは時間軸を触るので下書きの段階で隣と重なりうる。Main も保存時に必ず検査するが、そこで初めて弾かれると「保存を押したのに失敗した」体験になる。そこで `camera-state.ts` の `previewIssues()` が下書きを反映した並びを組み立て、**重なりがあれば保存ボタンを押せなくする**。★Main 側の検査を置き換えるものではない（Rendererを信用しない方針は不変）。

**★`syncMode: 'common'` のときの注意**
`build-project.ts` が `trimStartSec` 分だけ前詰めするため、**XML上の時刻が画面の表示とずれる**。画面は常に解析時刻で表示し、その旨を `syncModeNotice` として明示する（カットの前後関係は変わらない）。

**★今回の制限**
- カット同士が重なる編集はできない（Premiereのタイムラインが崩れるため）。
- 最短カット長は 2.5 秒（`DEFAULT_CAMERA_RULES.minShotSec` に合わせた）。
- 全カットの削除はできない。

### 確認画面（Review）— マーカー（2026-08-05 追加 / Step 8）

字幕・ショート候補・カメラ切替と同じ3レイヤー分離・`expectedUpdatedAt` の競合検出・`saveProject()` の原子的保存・`recordEdit()` の履歴で作る。**`packages/*` は1ファイルも変更していない**。

| 関心事 | 実装 |
|---|---|
| データ組み立て・保存 | `apps/desktop/src/main/marker.ts` |
| 入力検証 | `apps/desktop/src/shared/marker-validate.ts` |
| DTO | `apps/desktop/src/shared/marker-dto.ts` |
| 画面 | `apps/desktop/src/renderer/MarkerScreen.tsx` + `marker-state.ts` |
| 再出力の工程固定 | `apps/desktop/src/main/ipc.ts` の `MARKER_EXPORT_STEPS` |

**★マーカーIDには2系統あり、再解析後の挙動が分かれる（実測で確認）**

`generate-markers.ts` は2通りの採番をしている。`timeFromId()` に実IDを通して確認した。

| 種別 | 採番 | `timeFromId` | 再解析後 |
|---|---|---|---|
| TOPIC / LAUGH | `markerId(kind, startSec)` → `mk-TOPIC-00000000` | **時刻を返す** | **再接続される**（カメラ切替と同じ） |
| CHECK | `mk-CHECK-${check.id}` → `mk-CHECK-check-lowconf-7700` | **undefined** | **必ず孤立**（ショート候補と同じ） |

つまり **カメラ型とショート型が同居する初めての画面**。実データでは5件中3件が CHECK（＝孤立する側）だった。

この差を `volatileId` として1件ずつDTOに載せ、**編集画面で個別に警告する**。判定は自前の正規表現を写さず `@contentos/core/project` の `timeFromId()` をそのまま使う（写すと本体が変わったときにここだけ古い判定のまま残るため）。

**★CHECK マーカーの編集は禁止しない。**
一時的に名前やコメントを付けて確認したい運用があるため、「再解析すると外れる」ことを明示したうえで使えるようにする。外れた内容は消さず「孤立した修正」として内容ごと提示する。

**★種別をまたぐ再接続が起きる（静かな取り違え）**

`resolve.ts` の `matchEdits` は**種別を見ず、時刻の近さだけ**で繋ぎ直す。実測で確認した：

```
解析側に LAUGH（10.1秒）しか無い状態で TOPIC（10.0秒）への修正を resolve すると
  reattached: [{ fromId: 'mk-TOPIC-00010000', toId: 'mk-LAUGH-00010100', deltaSec: 0.1 }]
  resolved  : [{ id: 'mk-LAUGH-00010100', kind: 'LAUGH', name: '第2章：本題へ' }]
  orphaned  : 0
```

**章タイトルが笑いマーカーに乗る**。孤立しないので画面に何も出ない。`resolve.ts` は凍結対象なので直せないため、`reattachedKindMismatch`（`reattached.fromId` の接頭辞と現在の `kind` を比較）で検出し「要確認」として提示する。★**システムは検出まで。自動で取り消したり付け替えたりはしない**（ショートの `rangeChanged`・カメラの `reattached` と同じ思想）。

**★マーカーの追加はできない（データモデル上の制約）**

```ts
markers: Record<string, { name?: string; comment?: string; deleted?: boolean }>
```

`edits.cameraShots` と違い **`inserted` 配列が無い**。追加するには `packages/core` の `EditsLayer` を変える必要があり変更禁止。**「編集」と「削除」だけの画面**になる。時刻・種別の変更も同じ理由で不可（受け取ったら検証で拒否する）。

**★カメラ切替のような整合性チェックは不要**

`build-project.ts` の `toFcp7Markers` を精査した結果、カメラ切替と違い次のリスクが無い。

- **throw しない**（「カメラ素材が見つかりません」に相当するものが無い）
- **黙って捨てる条件が無い**（`endFrame <= startFrame` に相当するものが無い）
- `escapeXml()` が全出力に掛かる（`fcp7xml.ts`）ので XML特殊文字は安全
- マーカー同士は干渉しない（重なりという概念が無い）

そのため検証層は「長さ・制御文字・未対応項目」だけを見る Subtitle 型に戻り、Renderer 側の `previewIssues` 相当も不要。

**★XMLの名前に `[KIND] ` が自動で前置される**

`markerName()` が `[${marker.kind}] ${marker.name}` を作る。実機で確認済み（`[TOPIC] 【実機確認】第1章：導入`）。人が `name` に `[TOPIC]` と入れると二重になるため画面に明記する（`namePrefixNotice`）。

**★再出力は `generate-premiere-xml` → `save-artifacts` → `save-project` の3工程**

カメラ切替・字幕と同じ。`save-artifacts.ts` は `ctx.analysis.markers.length`（＝**解析結果の件数**）を report.html に出すだけで `resolved.markers` を使わないため、**マーカー修正が反映される成果物は FCP7 XML だけ**。`generate-premiere-xml` は必須。

**★名前は空を拒否、コメントは空を許す**

`resolve.ts` が `edit?.name ?? marker.name` で解決するため、空文字の名前を保存すると「空にしたつもりが解析値に戻る」紛らわしい状態になる。名前を消したいときは修正の取り消しへ誘導する。コメントは補足情報で意図的に空にしたい場合があり、空文字のまま保存して差し支えない。

**★同一種別・同一時刻のID衝突**

`markerId(kind, startSec)` に連番が無いため理論上衝突しうる（実データでは未発生）。字幕IDの重複と同じ扱いで、衝突しているマーカーは**編集不可**にし `duplicateId` で示す。

**★`syncMode: 'common'` のときの注意**
`build-project.ts` が**共通区間の外にあるマーカーを黙って除外**し、含まれるものの時刻も前に詰める。画面は解析時刻で表示し、その旨を `syncModeNotice` で明示する。

### 字幕IDの形式（★2026-08-03 変更）

字幕IDは開始時刻から作る。**開始時刻が同じキューが複数あるときだけ、2件目以降に連番を付ける。**

```
sub-00020960      1件目（従来と同じ形）
sub-00020960-2    2件目
sub-00020960-3    3件目
```

**なぜ1件目のIDを変えないのか**：字幕IDは人間の修正（`edits.subtitles`）のキーそのもの。一括で振り直すと保存済みの修正がすべて孤立する。連番が付くのは「これまでIDが衝突していて修正を保存できなかった側」だけなので、**孤立する既存修正は原理的にゼロ**。

- 採番は `assignSubtitleIds()`（`packages/core/src/project.ts`）。**入力順に対して決定的**で、同じ入力からは毎回同じIDが返る。再実行のたびに `-2` と `-3` が入れ替わると、その分の修正が別のキューに付いてしまうため。
- `timeFromId()` は先頭にアンカーした `/^[a-z]+(?:-[A-Za-z_]+)?-(\d{8,})(?:-(\d+))?$/` で照合する。末尾の数字を拾う旧方式だと `sub-00020960-2` の `2` を時刻と誤読しかねないため。形式外のIDは `undefined` を返し、**誤った時刻へ変換しない**（間違った時刻を返すと修正が無関係なキューに再接続される）。
- カメラ切替（`shot-`）・章（`ch-`）・マーカー（`mk-<KIND>-`）のIDも同じ関数で扱う。連番は字幕にのみ付く。

**旧形式のプロジェクトとの互換性**

| 状態 | 挙動 |
|---|---|
| 新しく生成された字幕 | IDが一意なので編集可能 |
| 旧形式で重複IDが残っているプロジェクト | 重複箇所のみ編集不可（画面・Mainの両方で拒否）。他のキューは編集可能 |
| 旧形式を再解析した後 | 2件目以降に連番が付いて一意になり、編集可能になる |

**重複IDに修正が保存されている異常データ**：`resolveProject` は修正をIDで紐づけるため、その修正は同じIDの全キューに適用される。どちらへの修正だったかは機械的に決められないので、**自動でどちらかへ移し替えず**、確認画面に「要確認」として件数と内容を提示する（`ReviewData.ambiguous`）。再解析すれば解消する。

**ゼロ長キューは今回未修正。** 開始時刻の衝突を生む主因（`20.960 → 20.960` のようなキュー）だが、時間軸を勝手に詰めない方針のため自動削除はしない。`generate-subtitles` が件数を**警告として報告**するに留めている（工程の status が `warning` になる）。

---

## 3. 実装済み機能（コード＋テスト or 実機確認済みのみ）

| 機能 | 実装場所 | 確認状況 |
|---|---|---|
| ffmpeg / ffprobe 連携（バイナリ解決・尺取得・音声デコード） | `packages/media/src/ffmpeg.ts` | テスト＋実機（CLI経由でwide.mp4/cam_A.mp4等を実処理） |
| faster-whisper large-v3 / int8 文字起こし | `packages/media/src/transcribe.ts` + `scripts/transcribe.py` | 実機（日本語TTS音声・実プロジェクトのCLI実行で22語認識、モデル読込〜JSON化のサブフェーズ計測あり） |
| 音声同期（相互相関） | `packages/editing/src/audio-sync.ts` | テスト（20件）＋実機（オフセット算出をCLIで確認） |
| 音声補正（非破壊・ノイズ低減・ラウドネス正規化） | `packages/media/src/audio-correct.ts` | テスト（12件）＋実機（補正音2件生成を確認） |
| 話者判定（相槌・同時発話・沈黙除外） | `packages/editing/src/speaker-detect.ts` | テスト（29件）＋実機 |
| 字幕生成（キュー分割・話者付与） | `packages/editing/src/srt.ts` | テスト（30件）＋実機（6キュー・低confidence語15件を検出） |
| チャプター生成（発話間隔ヒューリスティック） | `packages/pipeline/src/steps/generate-chapters.ts` | 実機（1章分割を確認。ロジック単体テストは無し） |
| カメラ切替案（ルールベース） | `packages/editing/src/camera-plan.ts` | テスト（24件）＋実機（5カット生成を確認、assetsPatch伝播バグ修正後） |
| マーカー生成（TOPIC/LAUGH/CHECK等） | `packages/pipeline/src/steps/generate-markers.ts` | 実機（6件生成を確認） |
| ショート候補の一次抽出（ローカル・決定的） | `packages/editing/src/short-candidates.ts` | テスト（39件）＋実機 |
| FCP7 XML生成 | `packages/editing/src/fcp7xml.ts`, `build-project.ts` | テスト（21+41件）＋実機（xmllintで妥当性確認済み）。**Premiere実機読み込みは未検証** |
| プロジェクト保存（原子的書き込み） | `packages/core/src/project-store.ts` | テスト（20件）＋実機 |
| 人間修正レイヤー（3層分離・再接続・孤立検出） | `packages/core/src/resolve.ts`, `packages/pipeline/src/diff-report.ts` | テスト（26+9件）＋実機 |
| APIコスト管理（推定・上限・キャッシュキー・ローカルモード） | `packages/ai/src/cost.ts`, `local-provider.ts` | テスト（28件）。**パイプラインへの配線・実API接続は未実施** |
| 15工程パイプライン | `packages/pipeline/src/run-pipeline.ts` + `steps/*.ts` | テスト（29件・フェイク工程）＋実機フルラン（15/15完了） |
| キャッシュ（ハッシュ連鎖によるスキップ判定） | `run-pipeline.ts` | テスト＋実機（無変更再実行で15工程すべて数msでスキップ確認） |
| 再開（中断後の差分実行） | `run-pipeline.ts` | テスト（フェイクAbortController） |
| キャンセル（AbortSignal、ffmpeg/whisperの実プロセス停止） | `packages/media/src/process.ts`, `run-pipeline.ts` | テスト。**実機でのCtrl+C動作は未確認**（CLI実装のみ） |
| 部分実行（fromStep/toStep/onlySteps/force） | `run-pipeline.ts` | テスト＋実機（`--from generate-camera-plan --to generate-premiere-xml`を実行し4/4完了を確認） |
| CLI（通常出力・--json-progress） | `cli/src/pipeline.ts` | 実機（両モードの出力形式を確認） |

### Electron デスクトップアプリ（2026-08-01 追加）

| 機能 | 実装場所 | 確認状況 |
|---|---|---|
| ウィンドウ生成・Electron配線 | `apps/desktop/src/main/index.ts` | 実機（起動・Reactマウントを確認） |
| Preload（contextBridgeで21APIのみ公開） | `apps/desktop/src/preload/{index,api}.ts` | テスト（8件）＋実機（公開キーと`require`等の不在を確認） |
| IPCハンドラ（検証・事前チェック・排他の統合） | `apps/desktop/src/main/ipc.ts` | テスト（20件）＋実機 |
| 入力検証（パス・工程ID・同期モード・runId） | `apps/desktop/src/shared/validate.ts` | テスト（21件）＋実機（不正入力3種の拒否を確認） |
| project.json の読み取りと拒否 | `apps/desktop/src/main/project.ts` | テスト（16件）＋実機 |
| projectRoot解決・実行環境の事前チェック | `apps/desktop/src/main/project-root.ts` | テスト（14件）＋実機（`source: 'repo'` で解決） |
| 実行管理（二重実行防止・中止・異常終了時のロック解放） | `apps/desktop/src/main/run-manager.ts` | テスト（34件）＋実機（二重実行拒否・中止・孤児0件を確認） |
| 解析専用プロセス（dist/pipeline.js を動的import） | `apps/desktop/src/worker/analysis-worker.ts` | 実機（15工程フルラン・部分実行・文字起こし中の中止） |
| 安全なエラーDTOへの変換 | `apps/desktop/src/shared/errors.ts` | テスト（6件）＋実機（DTOに`technicalMessage`が無いことを確認） |
| 画面の状態遷移（未選択/選択済み/解析中/完了/警告/失敗/中止） | `apps/desktop/src/renderer/state.ts` | テスト（23件） |
| 工程一覧の本体との一致検証 | `apps/desktop/src/shared/steps.ts` | テスト（5件。`@contentos/pipeline` と突き合わせ） |
| 表示整形（経過時間・進捗率・成果物パスの短縮） | `apps/desktop/src/renderer/format.ts` | テスト（16件） |

### 確認画面：字幕（2026-08-03 追加）

| 機能 | 実装場所 | 確認状況 |
|---|---|---|
| Reviewデータの組み立て・字幕修正の保存 | `apps/desktop/src/main/review.ts` | テスト（32件）＋実機 |
| 字幕修正リクエストの検証 | `apps/desktop/src/shared/review-validate.ts` | テスト（32件）＋実機（6種の不正入力を拒否） |
| 再生用プレビュー・メディアトークン | `apps/desktop/src/main/media.ts` | テスト（17件）＋実機（AAC 32kHz/モノラル/47kbps を生成・再生） |
| 画面の状態遷移（loading/ready/dirty/saving/saved/conflict/export-running/export-complete/failed） | `apps/desktop/src/renderer/review-state.ts` | テスト（30件） |
| Review画面 | `apps/desktop/src/renderer/ReviewScreen.tsx` | 実機（データ層・IPC層のみ。ダイアログ経由のUI操作は未確認） |
| 部分再出力（字幕修正の反映） | `apps/desktop/src/main/ipc.ts` の `REVIEW_EXPORT_STEPS` | テスト（8件）＋実機（SRTへの反映を確認） |
| 字幕IDの曖昧性解消（連番付与・時刻復元） | `packages/core/src/project.ts` の `assignSubtitleIds` / `timeFromId` | テスト（24件）＋実データ移行確認 |
| 字幕生成工程（ID採番・ゼロ長キューの警告） | `packages/pipeline/src/steps/generate-subtitles.ts` | テスト（12件）＋実機 |

### プロジェクト一覧・新規作成・素材登録（2026-08-04 追加）

| 機能 | 実装場所 | 確認状況 |
|---|---|---|
| プロジェクト一覧（参照情報のみを保存） | `apps/desktop/src/main/project-registry.ts` | テスト＋実機 |
| 新規プロジェクト作成 | `apps/desktop/src/main/project-create.ts` | テスト＋実機（CLIで開けることまで確認） |
| 素材登録・役割設定・解析前チェック | `apps/desktop/src/main/assets.ts` | テスト（54件）＋実機（実ffprobeで5素材） |
| 入力検証（案件名・日付・出演者・素材ID・役割） | `apps/desktop/src/shared/setup-validate.ts` | テスト（42件）＋実機（不正入力5種を拒否） |
| 画面の状態遷移（一覧/作成/素材登録/保存/競合） | `apps/desktop/src/renderer/setup-state.ts` | テスト（20件） |
| 一覧・新規作成・素材登録の画面 | `apps/desktop/src/renderer/SetupScreen.tsx` | 実機（一覧の描画とAPI疎通。フォーム操作は人手で未確認） |

### 確認画面：ショート候補（2026-08-04 追加 / Step 6）

| 機能 | 実装場所 | 確認状況 |
|---|---|---|
| ショートデータの組み立て・採否/編集の保存 | `apps/desktop/src/main/shorts.ts` | テスト（43件）＋実機（実素材・実core関数で25項目） |
| 採否・編集リクエストの検証 | `apps/desktop/src/shared/shorts-validate.ts` | テスト（37件）＋実機（不正入力6種を拒否） |
| 画面の状態遷移（loading/ready/dirty/saving/saved/conflict/export-running/export-complete/failed＋絞り込み） | `apps/desktop/src/renderer/shorts-state.ts` | テスト（35件） |
| ショート候補画面 | `apps/desktop/src/renderer/ShortsScreen.tsx` | 実機（データ層・IPC層のみ。ダイアログ経由のUI操作は未確認） |
| IPCハンドラ（読み込み・保存・取り消し・再出力） | `apps/desktop/src/main/ipc.ts` | テスト（15件）＋実機（CDP経由で実アプリを操作） |
| 部分再出力（`SHORTS_EXPORT_STEPS` = save-artifacts + save-project） | `apps/desktop/src/main/ipc.ts` | テスト＋実機（shorts.csv への反映と FCP7 XML 不変を確認） |
| 孤立した判断の検出・提示 | `shorts.ts` の `toOrphaned` | テスト＋実機（再解析シナリオで確認） |
| 区間の取り違え検出（`rangeChanged`） | `shorts.ts` の `detectRangeChanges` | テスト＋実機（再解析シナリオで確認） |

### 確認画面：カメラ切替（2026-08-05 追加 / Step 7）

| 機能 | 実装場所 | 確認状況 |
|---|---|---|
| カメラデータの組み立て・4操作の保存 | `apps/desktop/src/main/camera.ts` | テスト（61件）＋実機（実素材・実core関数で36項目） |
| 入力検証（ID・カメラ実在・区間・重なり） | `apps/desktop/src/shared/camera-validate.ts` | テスト（50件）＋実機（不正入力8種を拒否） |
| 画面の状態遷移（＋追加フロー・絞り込み・整合性チェック） | `apps/desktop/src/renderer/camera-state.ts` | テスト（52件） |
| カメラ切替画面 | `apps/desktop/src/renderer/CameraScreen.tsx` | 実機（データ層・IPC層のみ。ダイアログ経由のUI操作は未確認） |
| IPCハンドラ（読み込み・変更・追加・削除・取り消し・再出力） | `apps/desktop/src/main/ipc.ts` | テスト（17件）＋実機（CDP経由で実アプリを操作） |
| 部分再出力（`CAMERA_EXPORT_STEPS` = XML + save-artifacts + save-project） | `apps/desktop/src/main/ipc.ts` | テスト＋実機（**FCP7 XML への反映と xmllint 妥当性を確認**） |
| 再接続（`reattached`）の検出・提示 | `camera.ts` の `buildCameraData` | テスト＋実機（再解析シナリオ） |
| 共通検証部品の切り出し | `apps/desktop/src/shared/validate-common.ts` | テスト（5件。`review-validate.test.ts` から移設） |

### 確認画面：マーカー（2026-08-05 追加 / Step 8）

| 機能 | 実装場所 | 確認状況 |
|---|---|---|
| マーカーデータの組み立て・3操作の保存 | `apps/desktop/src/main/marker.ts` | テスト（57件）＋実機（実素材・実core関数で31項目） |
| 入力検証（★2系統のID形式・名前・コメント） | `apps/desktop/src/shared/marker-validate.ts` | テスト（31件）＋実機（検証層で11項目・不正入力8種を拒否） |
| 画面の状態遷移（＋種別×状態の2軸絞り込み） | `apps/desktop/src/renderer/marker-state.ts` | テスト（41件） |
| マーカー画面 | `apps/desktop/src/renderer/MarkerScreen.tsx` | 実機（データ層・IPC層のみ。ダイアログ経由のUI操作は未確認） |
| IPCハンドラ（読み込み・修正・削除・取り消し・再出力） | `apps/desktop/src/main/ipc.ts` | テスト（15件）＋実機（CDP経由で実アプリを操作） |
| 部分再出力（`MARKER_EXPORT_STEPS`） | `apps/desktop/src/main/ipc.ts` | テスト＋実機（**XMLへの反映と xmllint 妥当性を確認**） |
| ★`volatileId`（再解析で外れるマーカー）の判定 | `marker.ts` の `isVolatileId` | テスト＋実機（実データのCHECK3件すべてで検出） |
| ★種別またぎ再接続の検出 | `marker.ts` の `toMarkerItem` | テスト＋実機（TOPIC→LAUGH を再現） |

---

## 4. 重要な設計判断

- **Premiere中心の設計**：本システムはPremiereを置き換えない。生成するのはPremiereへの入力（FCP7 XML・SRT・レポート）のみで、カラー調整・トランジション・音声ミキシング等は実装しない方針（GUI設計ドキュメント`docs/13-gui-mvp.md`に明記）。
- **無音を自動削除しない**：`speaker-detect.ts`・`camera-plan.ts`のいずれも沈黙区間を検出してカット・削除する機能を持たない。カメラ切替は「誰も話していない区間は直前のカメラを維持する」実装（テストで固定：`camera-plan.test.ts`「間を埋めるための切替をしない」）。
- **原音を上書きしない**：`audio-correct.ts`の`assertNonDestructive()`が入力パス＝出力パスなら実行前に例外を投げる。補正音は`cache/audio/corrected/`に別ファイルとして生成し、原音は`AudioSource.kind: 'original'`として常に有効トラック、補正音は`'corrected'`として常にミュートトラックでXMLに出力する（`build-project.ts`でテスト済み・実機でMD5不変を確認）。
- **AI解析結果と人間修正を別レイヤーで保持**：`Project.analysis`（再解析で丸ごと差し替え）／`Project.ai`（API評価。未使用）／`Project.edits`（人間修正・★絶対に上書きしない）の3層。`resolveProject(analysis, edits)`が両者を突き合わせて表示用の値を作る（`packages/core/src/resolve.ts`）。
- **再解析で人間修正を消さない**：`run-pipeline.ts`のオーケストレーションは`analysisPatch`を`workingAnalysis`にマージするだけで、`project.edits`には一切書き込まない。実機・テスト両方で確認済み。
- **孤立修正を黙って破棄しない**：IDが完全一致しない修正は時刻の近さ（既定±0.5秒）で再接続を試み、それも失敗したら`orphaned`として**内容ごと**報告する（`resolve.ts`の`matchEdits`、`diff-report.ts`の`buildResolveDiffReport`）。ショート候補のように時刻を含まないIDは再接続できないため、候補が変わったら必ず`orphaned`になる仕様（テストで固定）。
- **APIなしでもローカルモードで動く**：`packages/ai/src/local-provider.ts`の`LocalProvider`はAPIキー不要で、ローカル一次抽出のスコア順に並べるだけの実装。ただし**現状パイプラインからは呼ばれていない**（ショート候補の一次抽出はAPIを経由せずパイプライン内で完結しており、AI評価ステップ自体が存在しない）。
- **ショート候補の区間抽出はローカル、APIは評価担当**：`extract-short-candidates`工程（パイプライン）は`packages/editing/short-candidates.ts`の決定的ロジックのみを使用。API呼び出しは行わない。`ShortCandidateForReview`型・`rankShortCandidates()`インターフェースは`packages/ai/provider.ts`に定義済みだが、呼び出し元（パイプラインのAI評価工程）はまだ存在しない。
- **GUIはコア処理を直接持たない**：`packages/pipeline`は React/Electron/DOM をimportしない（`index.ts`のコメントに明記、`package.json`のdescriptionにも明記）。CLIとGUIは同じ`runPipeline()`を呼ぶだけの薄い層になる設計。
- **syncMode変更時に無効化される工程**：`generate-premiere-xml`・`save-artifacts`・`save-project`のみ。`sync-media`・`detect-speakers`・`generate-camera-plan`は再実行されない（`stepConfigSlice()`が`syncMode`を`generate-premiere-xml`の設定としてのみ扱うため）。テスト`run-pipeline.test.ts`「syncMode変更の影響範囲」で固定、実機では未検証。
- **文字起こしモデル変更時に無効化される工程**：`transcribe`・`generate-subtitles`・`generate-chapters`・`extract-short-candidates`とその下流（`generate-markers`・`generate-premiere-xml`等）。`sync-media`・`detect-speakers`・`generate-camera-plan`は再実行されない（`generate-camera-plan`は`transcribe`に依存しないため）。テストで固定、実機では未検証。

---

## 5. 現在のテスト状況（本ファイル作成時点で再確認済み）

```
$ npm run typecheck
> tsc --noEmit
（エラー0件）

$ npm test
Test Files  48 passed (48)
     Tests  1372 passed (1372)
```

内訳：コア 498件（21ファイル）＋ Electron 874件（27ファイル）。Electronのテストは ffmpeg・faster-whisper を一切起動せず、解析専用プロセスの起動関数を差し替えて検証している。

- **実機smoke testの結果**：`cli/src/pipeline.ts`を実プロジェクト（`project.json`＋実際のffmpeg/whisper）に対して複数回実行し、以下を確認済み。
  - フルラン：15/15完了（0失敗・0警告、修正後）
  - 無変更再実行：15/15すべてキャッシュヒットでスキップ（文字起こしの約15秒含め数ms）
  - `--force`での全工程強制再実行
  - `--from generate-camera-plan --to generate-premiere-xml --force`での部分実行（4/4完了）
  - `--json-progress`での1行1JSON出力
  - 生成された`ep012.fcp7.xml`相当のXMLを`xmllint --noout`で妥当性確認
  - 原音ファイル（`wide.mp4`・`audio/mic_A.wav`）のMD5・更新時刻が実行前後で不変
- **実機テストで発見・修正したバグ（assetsPatch伝播バグ）**：`probe-media`工程が確定させた素材の尺・fps等（`assetsPatch`）が、同一実行内の後続工程（`generate-camera-plan`等）に反映されていなかった。原因は`run-pipeline.ts`が`StepContext.project`を常に実行開始時点の元プロジェクトから構築しており、`workingAssets`（更新後の素材一覧）を反映していなかったこと。修正により実機での「カメラ切替案0カット」が「5カット」に改善。回帰テストを`run-pipeline.test.ts`に追加済み（`probe-mediaの更新が同一実行内の後続工程に反映される`）。
- **使用したfixture**：
  - `.selfcheck/検証素材 fixture/`（`npm run selfcheck`で生成。ffmpeg合成音声・40秒・日本語ではない正弦波ベース。同期オフセット・話者判定・笑い検出の単体検証に使用）
  - `.venv`（プロジェクト内Python仮想環境。faster-whisper 1.2.1導入済み）
  - CLI実機テスト用に`/private/tmp/.../scratchpad/cli-project/`へ`project.json`を作成し、`.selfcheck`のwide.mp4/cam_A.mp4/cam_B.mp4/audio/mic_{A,B}.wavを絶対パス参照するプロジェクトを構築して実行（このディレクトリはスクラッチ領域のため次回セッションには残っていない可能性が高い。再現する場合は`npm run selfcheck`でfixtureを再生成してから同様の`project.json`を作成すること）。
- **確認済みのCLIコマンド**：
  ```bash
  npm run pipeline -- --project <projectDir>
  npm run pipeline -- --project <projectDir> --force
  npm run pipeline -- --project <projectDir> --from generate-camera-plan --to generate-premiere-xml --force
  npm run pipeline -- --project <projectDir> --json-progress
  npm run pipeline -- --help
  npm run selfcheck
  npm run build
  ```
- **workspace import 移行後（2026-08-01）に再確認した内容**：型チェック エラー0件、テスト 19ファイル/462件すべてpass（★当時の件数。移行前と同一で、移行がロジックを変えていないことの根拠。現在は48ファイル/1372件）、`npm run pipeline -- --help` が15工程を正常に列挙、`npm run build` 成功。加えて **`--experimental-strip-types` を付けない素の `node` で `dist/pipeline.js`・`dist/core.js` を読み込み、`runPipeline` の取得・15工程の確認・`createProject()`／`resolveProject()` の実行に成功**（＝Electronメインプロセスから解析を呼べることの前提条件を実証済み）。
- **Electron実機確認（2026-08-01）**：`.selfcheck` のfixtureから作った実プロジェクト（5素材・40秒）に対して、**実際にElectronアプリを起動し、Chrome DevTools Protocol でRendererを操作して**以下を確認した。
  1. アプリ起動・ウィンドウ生成・Reactのマウント（未選択画面の描画）
  2. `window.contentOs` が公開しているキーがちょうど7つ（`selectProject` / `readProjectSummary` / `startPipeline` / `cancelPipeline` / `openProjectFolder` / `onPipelineProgress` / `onPipelineFinished`）**※これは2026-08-01時点の記録。現在は40個**（Step 3で+5、Step 5で+9、Step 6で+4、Step 7で+6、Step 8で+5、Step 10で+4。最新の一覧は `preload/api.ts` の `ALLOWED_API_KEYS` が唯一の正）
  3. **Rendererから `window.require` / `window.process` / `window.module` / `window.ipcRenderer` がすべて `undefined`**（contextIsolation + sandbox が効いている）
  4. `readProjectSummary` が案件名・ID・パス・ステータス・素材数・最終更新を返す
  5. 不正入力の拒否：相対パス・未知の工程ID（`rm -rf /`）・不正なrunId（`../../etc/passwd`）がすべて `INVALID_REQUEST` で拒否され、解析プロセスは起動しない
  6. 解析開始 → runId 発行 → 進捗イベントがRendererまで届く（`stepId` / `stepLabel` / `stepIndex` / `overallRatio` / `stepRatio` を含む）
  7. **実行中の再開始が `PROJECT_ALREADY_RUNNING` で拒否される**
  8. 中止 → `outcome: 'cancelled'` の完了イベント。中止完了後は再実行できる
  9. **IPCで届いたDTOに `technicalMessage` / 文字起こし全文（`words`）/ `project`（`rootDir`）が含まれない**
  10. `openProjectFolder` で有効なプロジェクトのFinderが開き、`/etc` や相対パスでは開かない
  11. 購読解除後は進捗イベントが届かない（0件）
  12. アプリ終了後に**孤児の解析プロセスが残らない**（0件）
- **解析専用プロセス単体の実機確認**：Electronバイナリを `ELECTRON_RUN_AS_NODE=1` で起動し、`dist/pipeline.js` を動的importして
  - 15工程フルラン完走（100秒・成果物14件・`ep999.fcp7.xml` 生成）
  - 部分実行（`--to sync-media` 相当）4工程を2.9秒で完了
  - **文字起こし工程の途中での中止**（whisperの子プロセスが停止し、`cancelled: true` で完了報告）
- **★CLI回帰とキャッシュ共有の確認**：GUIで解析した同じプロジェクトに対して `npm run pipeline -- --project <dir> --to sync-media` を実行すると、**4工程すべてがキャッシュヒットしてスキップされた**。GUIとCLIがキャッシュを共有できている（＝`TranscribeConfig` に `projectRoot` を足さない判断が正しく効いている）ことの実証。
- **確認画面の実機確認（2026-08-03）**：実際にElectronアプリを起動し、CDP経由で以下を確認した。
  1. 確認画面のデータ読み込み（8キュー / 低confidence語125 / 話者2名 / ID重複2件を検出）
  2. 低confidence語と最小信頼度が表示用データとして返る
  3. **DTOに `pipeline` 工程記録・`apiUsage`・素材の絶対パス・`edits` レイヤーが含まれない**
  4. 不正入力6種をすべて拒否（不正subtitleId / 存在しないspeakerId / タイムコード編集 / 長すぎる本文 / 制御文字 / 古いupdatedAt）
  5. 字幕本文と話者を修正して保存 → `updatedAt` が更新される
  6. **再読み込みしても修正が残る**（解析側の元本文も併せて参照できる）
  7. 古い `updatedAt` での再保存が競合として拒否される
  8. **再出力（3工程のみ）で `subtitle.srt` の該当行が「つい」→「【実機確認】ここを人が直しました」に変わった**
  9. **`analysis.subtitles` は作業の前後で完全一致**（差分は `generatedAt` / `fingerprint` / `checks` のみ＝パイプライン実行が書くメタ情報）
  10. CLIでフル解析を実行しても `edits.subtitles` が保持された（＝再解析で人間修正が消えない）
  11. プレビュー音声を生成（AAC / 32kHz / モノラル / 47kbps / 241KB）。元素材は無変更
  12. **メディアプロトコルの防御**：正規トークンのURLは `<audio>` で再生でき（duration 40秒）、偽造トークンは拒否、`file:///etc/passwd` はCSPで遮断
- **プロジェクト一覧・新規作成・素材登録の実機確認（2026-08-04）**：
  1. Electron起動時の入口がプロジェクト一覧になっている（画面テキストで確認）
  2. Preloadの公開APIは21個。`require` / `process` / `ipcRenderer` はすべて `undefined`
  3. 不正入力5種を拒否（相対パスの保存先 / 案件名のスラッシュ / 存在しない日付 / 出演者0名 / 未知のsyncMode）
  4. 新規プロジェクト作成 → `2026-08-05_実機確認 第1回` フォルダと project.json を生成
  5. 一覧に載り、素材数が project.json から読み直される
  6. **実ffprobeで5素材を登録**（wide / cam_A / cam_B / mic_A / mic_B）。尺40秒・640×360・30fps・1ch/48000Hz を取得
  7. 役割の自動推測がすべて的中（ただし `roleConfirmed: false` のまま）
  8. **役割未確定では `canAnalyze: false`**（`ROLE_UNCONFIRMED` × 5）
  9. 役割を確定すると `canAnalyze: true` に変わり、出演者A/Bのマイク・カメラが紐づく
  10. 重複登録・映像音声でないファイル（`expected.json`）を拒否
  11. 競合更新（古い `updatedAt`）を検出して上書きしない
  12. **DTOに素材の絶対パスが含まれない**
  13. 解析開始が既存Step 2の経路で通り、**CLIでも同じ project.json を開けて解析できた**
  14. 字幕Reviewへ接続できる（`reviewLoad` が成功）
  15. **元素材のMD5が登録前後で完全一致**（移動・コピー・変更なし）
- **再出力が依存未完了で失敗する場合の確認**：中止された工程（`correct-audio: cancelled`）が残った状態で再出力すると、`DEPENDENCY_NOT_COMPLETED`「依存する工程「correct-audio」がまだ完了していません。」が返り、**誤った成果物を作らずに停止する**ことを確認した。フル解析を1回通せば解消する。
- **ショート候補Reviewの実機確認（2026-08-04 / Step 6）**：`.selfcheck` fixture から実プロジェクトを作り、**実ffmpeg・実faster-whisper でフル解析15/15完走**（ショート候補1本抽出）。その上で3系統の検証を行った。

  **(A) 実 `@contentos/core` 関数での検証（フェイクを使わない）— 25項目すべて合格**
  1. 候補を読み込め、未判断で始まる
  2. 再解析の警告（`reanalysisWarning`）と CSV非対象項目（`fieldsNotExported`）がDTOに載る
  3. **DTOに素材の絶対パス・`analysis`・`edits`・文字起こし全文（`words`）が含まれない**
  4. 採否・タイトル・フック・投稿文・ハッシュタグ・メモを保存でき、`updatedAt` が更新される
  5. **★保存前後で `analysis` が文字列レベルで完全一致**
  6. **★書き換わるのは `edits.shorts` と `edits.history` だけ**（`subtitles` / `cameraShots` / `chapters` / `markers` / `syncOffsets` は不変）
  7. 履歴が `kind: 'short'` で残り、`before` / `after` を保持する
  8. **判断時の区間が `field: 'candidateRange'` として履歴に残る**
  9. **古い `updatedAt` を `PROJECT_CHANGED` で拒否し、上書きしない**（拒否後も元の値のまま）
  10. 解析に無いID（`short_99`）を `SHORT_NOT_FOUND` で拒否し、`edits` に書かない
  11. 再読み込みしても判断が残る

  **(B) 再解析シナリオ — 10項目すべて合格**
  - 候補が消えた場合：`orphaned` として**内容ごと**（採否・タイトル・メモ）返し、**`project.json` からは消さない**
  - IDは残るが区間が変わった場合：`orphaned` にならず `rangeChanged` で検出し、判断時の区間を併せて返す。**判断は自動で取り消さない**

  **(C) 実 Electron アプリ（CDP経由でRendererを操作）— 25項目すべて合格**
  1. **Preloadの公開APIはちょうど25個**（Step 5の21個 + ショート4個）
  2. **`window.require` / `window.process` / `window.module` / `window.ipcRenderer` がすべて `undefined`**
  3. IPC経由でショート候補を読み込め、警告文がDTOに載る
  4. **DTOに素材の絶対パス・`analysis`・`edits`・`technicalMessage` が含まれない**
  5. **不正入力6種を拒否**：相対パス / 不正なショートID / 区間の編集（未対応）/ 改行入りタイトル / 古い `updatedAt` / 解析に無いID
  6. GUIから保存でき、ハッシュタグの先頭 `#` が正規化される。既存の採否・タイトルは保たれる
  7. 再出力の実行工程が `['save-artifacts', 'save-project']` のみ
  8. **実行中の再出力を `PROJECT_ALREADY_RUNNING` で拒否**
  9. 再出力が `DEPENDENCY_NOT_COMPLETED` で止まらず `outcome: 'completed'` で完走
  10. **既存の字幕Review（`reviewLoad`）が壊れていない**
  11. アプリ終了後に**孤児プロセス0件**

  **(D) 成果物の実機確認**
  ```
  shorts.csv:   short_01,...,未判断,""            → short_01,...,採用,"【実機確認】笑いのピーク"
  FCP7 XML:     b8a4cc96aa0e01be448678a752607f9c → b8a4cc96aa0e01be448678a752607f9c（不変）
  subtitle.srt: 0fb075220addf0e6fb626e251e60b6eb → 0fb075220addf0e6fb626e251e60b6eb（不変）
  ```
  **元素材（wide.mp4 / cam_A.mp4 / mic_A.wav）のMD5も全工程の前後で完全一致**（読むだけ）。
- **カメラ切替Reviewの実機確認（2026-08-05 / Step 7）**：`.selfcheck` fixture から実プロジェクトを作り、**実ffmpeg・実faster-whisper でフル解析15/15完走**（カメラ切替5カット）。3系統で検証した。

  **(A) 実 `@contentos/core` 関数での検証 — 36項目すべて合格**
  1. 5カットを読み込め、カメラ候補は `wide` / `cam_A` / `cam_B` のみ（マイクを含まない）
  2. 表示名（引き / 寄りA）と理由の日本語を返す。連続したカットは重なり0・隙間0
  3. **DTOに素材の絶対パス・`analysis`・`edits`・文字起こし全文が含まれない**
  4. カメラを差し替えると**並び全体**が返り、解析の元の値も併せて返る
  5. **★保存前後で `analysis` が文字列レベルで完全一致**
  6. **★書き換わるのは `edits.cameraShots` と `edits.history` だけ**（`subtitles` / `shorts` / `chapters` / `markers` は不変）
  7. **★XMLを壊す入力を6種すべて拒否**：存在しないカメラ / 隣と重なる時刻 / ゼロ長 / 素材の尺を超過 / 重なる追加 / 古い `updatedAt`。拒否後も `overrides` の件数が変わらない
  8. **★最短2.5秒を下回る変更を拒否**（実データで 33.69→36 秒＝2.31秒を拒否）
  9. カットの追加ができ、IDが `shot-ins-00037000`、`reason` が `hold`
  10. 削除で `deletedIds` に積まれ、隙間が警告として数えられる。取り消しでカットが戻る

  **(B) FCP7 XML への反映 — CLI 経由**
  ```
  XML MD5:  6a00c81a... → 053c2346...（変化）
  V1クリップ数: 5 → 6
  xmllint --noout : 妥当
  ```
  V1トラックの中身（カメラ修正がそのまま出ている）：
  ```
      0 →  290 : cam_A.mp4 (speech)
    290 →  590 : wide.mp4 (speech)    ← cam_B から差し替えたカット
    590 →  770 : wide.mp4 (merged)
    770 → 1010 : cam_A.mp4 (speech)
   1010 → 1109 : wide.mp4 (laughter)  ← 40秒→37秒に縮めたカット
   1109 → 1199 : wide.mp4 (hold)      ← 人が追加したカット（暫定reason）
  ```

  **(C) 実 Electron アプリ（CDP経由）— 27項目すべて合格**
  1. **Preloadの公開APIはちょうど31個**（Step 6の25個 + カメラ6個）
  2. **`window.require` / `window.process` / `window.module` / `window.ipcRenderer` がすべて `undefined`**
  3. IPC経由で読み込め、再出力の注意書きがDTOに載る
  4. **DTOに絶対パス・`analysis`・`edits`・`technicalMessage` が含まれない**
  5. **不正入力8種を拒否**：相対パス / 不正なカットID / 存在しないカメラ / 隣と重なる時刻 / ゼロ長 / 古い `updatedAt` / 重なる追加 / `reason` 指定
  6. GUIから差し替えると並び全体が返り、再読み込みしても残る
  7. 再出力の実行工程が `['generate-premiere-xml', 'save-artifacts', 'save-project']`
  8. **実行中の再出力を `PROJECT_ALREADY_RUNNING` で拒否**、`outcome: 'completed'` で完走
  9. **GUIでの差し替えが XML に反映**（1カット目が `cam_A` → `cam_B`）。xmllint 妥当
  10. **既存の字幕Review・ショート候補Reviewが壊れていない**
  11. アプリ終了後に**孤児プロセス0件**

  **元素材（wide.mp4 / cam_A.mp4 / mic_A.wav）のMD5は全工程の前後で完全一致**（読むだけ）。
- **マーカーReviewの実機確認（2026-08-05 / Step 8）**：Step 7 と同じ実プロジェクト（実ffmpeg・faster-whisper でフル解析済み・マーカー5件）に対して4系統で検証した。

  **(A) 実 `@contentos/core` 関数での検証 — 31項目すべて合格**
  1. 実データの5マーカーを読み込め、種別ごとの件数（TOPIC1 / LAUGH1 / **CHECK3**）を返す
  2. **★実データの CHECK 3件すべてに `volatileId` が立ち、TOPIC / LAUGH には立たない**
  3. 注意書き（XML限定・`[KIND]` 前置）と、時刻編集・追加が未対応であることを返す
  4. **DTOに素材の絶対パス・`analysis`・`edits`・文字起こし全文が含まれない**
  5. 名前とコメントを修正でき、解析の元の値も併せて返る
  6. **★CHECK（volatile）も編集を許可する**（方針どおり禁止しない）
  7. **★保存前後で `analysis` が文字列レベルで完全一致**
  8. **★書き換わるのは `edits.markers` と `edits.history` だけ**
  9. 削除すると一覧から消えるが**`analysis` からは消さない**（戻せる状態を保つ）。取り消しで戻る
  10. **★再解析シナリオ**：TOPIC は時刻で繋ぎ直され修正が生き、CHECK は「IDから時刻を読み取れず」で孤立して内容ごと提示される。孤立しても `project.json` からは消さない
  11. **★★種別またぎの検出**：TOPIC への修正が LAUGH マーカーへ繋ぎ直された状況を再現し、`reattachedKindMismatch` で検出。**自動では取り消さない**

  **(B) 検証層（実データのIDを通す）— 11項目すべて合格**
  実プロジェクトの5つのマーカーIDすべてが検証層を通ること（★2系統の形式を両方受けられること）を確認。加えて不正入力8種を拒否：空の名前 / 名前に改行 / 時刻の編集 / 種類の変更 / 内容なし / 相対パス / パス断片のID / 古い形式の `updatedAt`。**コメントの空文字は許可**することも確認。

  **(C) FCP7 XML への反映 — CLI 経由**
  ```
  XML MD5: eec9a0d6... → d93ef170...（変化）  マーカー数: 5 → 4（削除を反映）  xmllint 妥当
    in=   0 '[TOPIC] 【実機確認】第1章：導入'   comment='人が直した章名'
    in= 231 '[CHECK] 確認済み（一時メモ）'      ← ★CHECK の一時編集も反映される
    in= 990 '[CHECK] 要確認'
    in=1019 '[LAUGH] 笑い（2.0秒）'
  ```
  `[KIND] ` の自動前置と、削除したマーカーがXMLから消えることを実物で確認。

  **(D) 実 Electron アプリ（CDP経由）— 30項目すべて合格**
  1. **Preloadの公開APIはちょうど36個**（Step 7の31個 + マーカー5個）
  2. **`window.require` / `window.process` / `window.module` / `window.ipcRenderer` がすべて `undefined`**
  3. IPC経由で読み込め、削除を反映した4件が返る。CHECK 2件に `volatileId` が立つ
  4. **DTOに絶対パス・`analysis`・`edits`・`technicalMessage` が含まれない**
  5. **不正入力9種を拒否**：相対パス / 不正なマーカーID / パス断片のID / 空の名前 / 名前に改行 / 時刻の編集 / 種類の変更 / 古い `updatedAt` / 存在しないID
  6. **★CHECK（volatile）をGUIから編集でき、`volatileId` が返る**（警告表示の根拠）
  7. 再出力の実行工程が `['generate-premiere-xml', 'save-artifacts', 'save-project']`
  8. **実行中の再出力を `PROJECT_ALREADY_RUNNING` で拒否**、`outcome: 'completed'` で完走
  9. **GUIでの編集が XML に反映**（`comment='GUIから確認済み'`）。xmllint 妥当
  10. **既存の字幕・ショート候補・カメラ切替の3画面がすべて壊れていない**
  11. アプリ終了後に**孤児プロセス0件**

  **元素材（wide.mp4 / cam_A.mp4 / mic_A.wav）のMD5は全工程の前後で完全一致**（読むだけ）。

- **復旧画面の実機確認（2026-08-09 / Step 10）**：合成素材（selfcheck fixture）を**実 ffmpeg・faster-whisper でフル解析**した実プロジェクト（字幕4・カメラ5カット・マーカー4・ショート候補1）に対し、5種10件の「要確認」を仕込んで確認した。

  **(A) 一覧（4ドメイン × 5種）— すべて表示**
  要確認10件（孤立4 / 繋ぎ直し3 / 種別またぎ1 / 区間変化1 / 解析変化1）、対象別に 字幕3・ショート2・カメラ2・マーカー3。**時刻順に並び**、時刻を持たない項目（CHECK系マーカー・ショート）だけが末尾に回る。絞り込みは対象・種別とも単独／重ね掛けの両方で正しく件数が変わる。

  **(B) 付け替え（Reattach）— 4ドメインすべて成立**
  - 字幕：`sub-00100000` → `sub-00033280`。`edits.subtitles` のキーが移り、孤立が消える
  - ショート：`short_07` → `short_01`（IDに時刻が無くても成立）
  - カメラ：`shot-00090000`（削除指定）→ `shot-00033690`。`deletedIds` の配列要素が差し替わる
  - マーカー：`mk-CHECK-check-lowconf-9999` → `mk-TOPIC-00000000`（CHECK系も成立）
  - **★埋まっている要素は候補一覧で「選択不可」になり押せない**（実際に字幕で1件、ショートで1件発生）。先客を押し出して新しい孤立を作らないことを実機で確認

  **(C) 破棄（Discard）— 4ドメイン × 5種すべて成立**
  10件すべてで `edits` から消え、一覧から消える。全件破棄すると **要確認0件**になり、「消せない項目」が残らない。

  **(D) 戻る導線**
  復旧画面 →「解析画面へ戻る」→ 解析画面 → 字幕／ショート／カメラ／マーカーの4画面へそれぞれ入って戻れることを確認。**既存4画面はすべて無傷**。

  **(E) エラーケース**
  - 画面を開いたまま外部で `project.json` が更新されると **`競合しています` バッジが出て、破棄・付け替えの両ボタンが押せなくなる**
  - 検証層が拒否：対象が不正（`chapter`）／対象とIDの取り違え（マーカーに字幕ID）／`updatedAt` 無し／相対パス → いずれも `INVALID_REQUEST`
  - 同一IDへの付け替え → 「付け替え先が元と同じです。」
  - 存在しないプロジェクト → `INVALID_PROJECT`

  **(F) 成果物（Recovery操作後の再出力）**
  GUIで付け替え2件＋破棄1件を行ってから `generate-premiere-xml` / `save-artifacts` / `save-project` を再実行し、**成果物6点すべてが正しく再生成される**ことを確認した。FCP7 XML は **xmllint 妥当**で、付け替えたマーカーのコメント（`<comment>孤立したメモ</comment>`）が実際にXMLへ出ている。`subtitle.srt` は破棄した孤立修正が消え、残した修正が反映される。`shorts.csv` に採否とタイトルが出る。`youtube-chapters.txt` は変更なし（章を触っていないため）。**元素材のMD5は全操作の前後で完全一致**。

  **★実機でしか出なかった不具合を3件見つけて直した**（テストは通っていた）
  1. 繋ぎ直し項目に時刻を載せておらず、一覧が時刻順に並ばずその項目だけ再生位置へ飛べなかった
  2. 判断を破棄したショートに「区間変化」が残り続けた（`rangeChanged` は追記のみの `edits.history` から算出されるため）。**破棄しても消えない項目**になっていた
  3. 戻るボタンの文言が既存4画面と食い違っていた

  **公開APIはちょうど40個**（Step 8の36個 + 復旧4個）。`window.require` / `window.process` / `window.ipcRenderer` はいずれも `undefined` のまま。

---

## 6. 未検証事項

- **Premiere ProでのXML実機確認**：`xmllint`での構文妥当性は確認済みだが、実際にPremiere Proで読み込み・素材リンク・マーカー表示・音声トラック構成（原音有効／補正音ミュート）が意図通りかは**未検証**。ユーザー側での検証待ち（`docs/measurements/premiere-check-guide.md`参照）。
- **長尺の実素材**：これまでの検証は7.5秒（TTS音声）・40秒（合成fixture）のみ。10分規模の実収録での処理時間・メモリ使用量・文字起こし精度は未計測。
- **実素材での笑い・話者判定精度**：`speaker-detect.ts`の閾値は合成波形（正弦波ベース）でチューニングしたもので、実際の人間の声・実際の笑い声での精度は未確認。
- **同一プロジェクトの同時実行**：`packages/pipeline` 側の排他制御（ロック機構）は未実装のまま。Electronアプリ内では `main/run-manager.ts` が防いでいるが、**CLIとGUIを同時に同じプロジェクトへ走らせた場合は防げない**（プロセスをまたぐロックが無いため）。挙動は未定義・未検証。
- **実際の容量不足・権限エラー**：`PipelineErrors.diskFull`・`PipelineErrors.permissionDenied`はエラーメッセージとして実装済みだが、実際にディスク容量を枯渇させた状態・書き込み権限を剥奪した状態でのテストは未実施。
- **Gemini / OpenAIの本接続**：`packages/ai`はインターフェース・コスト計算・ローカルモードのみ実装。実際のAPI呼び出し（`GeminiProvider`等）は未実装。
- **低解像度プレビュー生成**：確認画面が必要とする音声のみ／低解像度プレビューの書き出し機能は未実装（設計ドキュメントに記載のみ）。
- **【Electron】ファイル選択ダイアログ経由のUI操作**：`dialog.showOpenDialog` はOSネイティブのため自動操作できず、**「プロジェクトを選択」ボタンを押してダイアログでファイルを選ぶ経路だけは人手で未確認**。それ以外（情報表示・開始・進捗・中止・完了・フォルダを開く）はCDP経由で実アプリを操作して確認済み。
- **【Electron】アプリの強制終了（SIGKILL）時の解析プロセス**：`before-quit` 経由の通常終了では解析プロセスが確実に終了することを確認済み（孤児プロセス0件）。ただしSIGKILLでMainが即死した場合、`fork` した解析プロセスが孤児として残る可能性がある（未検証）。
- **【Electron】パッケージ配布**：`app.isPackaged` の分岐は実装済みだが、実際にアプリをパッケージ化して `resources` から projectRoot を解決する経路は未検証（インストーラは今回のスコープ外）。
- **【Electron】長時間実行時のUI**：40秒のfixtureで100秒の完走を確認したのみ。10分規模の素材での進捗表示の見え方・メモリは未計測。
- **【確認画面】画面上の操作**：データ層・IPC層はCDP経由で実アプリを操作して確認済みだが、**ファイル選択ダイアログを経て確認画面を開き、一覧をクリックして本文を打ち替える一連のUI操作は人手で未確認**（ダイアログがOSネイティブのため自動化できない）。状態遷移そのものはリデューサのテスト30件で固定してある。
- **【確認画面】長い字幕一覧の描画**：8キューでの確認のみ。10分規模（数百キュー）でのスクロール性能・再生同期の追随は未計測。
- **【一覧・素材登録】ドラッグ＆ドロップの実機確認**：`webUtils.getPathForFile`（Electron 32以降の公式方式）で実装しているが、**実際にファイルをドラッグして落とす操作は人手で未確認**。CDPからは本物の `File` オブジェクトを作れず、Preloadがパスを解決できないため到達できない（設計上正しい挙動）。Main側の登録処理は実ffprobe込みで確認済み。
- **【一覧・素材登録】ファイル選択ダイアログ経由の登録**：OSネイティブのため自動化できず未確認。ダイアログが返すパスを使う経路自体は、ドロップ経路と同じ `registerAssets` を通る。
- **【一覧・素材登録】フォーム操作**：新規作成フォームへの入力・素材一覧での役割変更は、状態遷移をリデューサのテスト20件で固定しているが、画面上のクリック操作は人手で未確認。
- **【一覧】3名以上の出演者**：`SPEAKER_SLOTS` は A/B/C の3枠まで。4名以上には `SPEAKER_SLOTS` と `ASSET_ROLES` の拡張が要る（構造は対応済みだが未検証）。
- **【確認画面】プレビュー生成の所要時間**：40秒素材で即時。長尺素材での生成時間と、生成中のUIの見え方は未検証（生成は非同期で行うためメインプロセスは止まらない）。
- **【ショート候補】画面上の操作**：データ層・IPC層はCDP経由で実アプリを操作して確認済みだが、**解析画面から「ショート候補を確認」ボタンを押し、一覧をクリックして採否を切り替える一連のUI操作は人手で未確認**（ファイル選択ダイアログがOSネイティブで自動化できないため、そこから先の画面に到達できない）。状態遷移そのものはリデューサのテスト35件で固定してある。
- **【ショート候補】候補が多数ある場合**：実素材から抽出できた候補が**1本だけ**だったため、数十件でのスクロール性能・絞り込み（すべて/未判断/採用/不採用）の体感・再生位置による自動選択の追随は未計測。
- **【ショート候補】`rangeChanged` の実素材での発生頻度**：検出ロジックは再解析シナリオを人工的に作って確認したが、**実際の再解析でどのくらいの頻度で起きるか**は未計測（素材や設定を変えて2回解析した実データが無いため）。
- **【ショート候補】3桁以上のID**：検証の正規表現は `short_100` / `short_1000` を通すことをテストで固定しているが、**実際に候補が100本を超える素材での動作は未確認**。
- **【カメラ切替】画面上の操作**：データ層・IPC層はCDP経由で実アプリを操作して確認済みだが、**解析画面から「カメラ切替を確認」ボタンを押し、一覧をクリックしてカメラを差し替える・時刻を入力する一連のUI操作は人手で未確認**（ファイル選択ダイアログがOSネイティブで自動化できないため）。状態遷移はリデューサのテスト52件で固定してある。
- **【カメラ切替】Premiere での実機読み込み**：再出力した FCP7 XML は `xmllint` で妥当性を確認し、V1トラックにカメラ修正が正しく並ぶことも確認したが、**実際に Premiere Pro で開いて意図どおりのタイムラインになるかは未検証**（Premiere実機検証そのものがユーザー側で未実施のため）。★カメラ切替は XML を書き換える唯一の画面なので、Premiere検証時はこの画面で修正した状態でも確認すること。
- **【カメラ切替】カットが多数ある場合**：実素材のカットが5本だけだったため、数十〜数百カットでのスクロール性能・絞り込みの体感・整合性チェック（`previewIssues` は毎回全件をソートする）の速度は未計測。
- **【カメラ切替】`syncMode: 'common'` での時刻ずれ**：注意書きは出しているが、**実際に common モードで再出力してXML上の時刻を突き合わせた確認は未実施**。
- **【カメラ切替】`reason` の暫定措置**：人が追加したカットに `'hold'` を使っている。**Premiereのクリップ名に `(hold)` と出ることの実運用上の見え方は未確認**。
- **【カメラ切替】3台以上のカメラ**：`wide` / `cam_A` / `cam_B` の3台で確認。`cam_C` を含む4台以上での動作は未確認（`ASSET_ROLES` は `cam_C` まで定義済み）。
- **【マーカー】画面上の操作**：データ層・IPC層はCDP経由で実アプリを操作して確認済みだが、**解析画面から「マーカーを確認」ボタンを押し、一覧をクリックして名前・コメントを打ち替える一連のUI操作は人手で未確認**（ファイル選択ダイアログがOSネイティブで自動化できないため）。状態遷移はリデューサのテスト41件で固定してある。
- **【マーカー】Premiere でのマーカー表示**：再出力した FCP7 XML に `<marker>` が正しく並ぶことと `[KIND] ` 前置は確認したが、**実際に Premiere Pro で開いてマーカーパネルに意図どおり表示されるかは未検証**（Premiere実機検証がユーザー側で未実施のため）。
- **【マーカー】マーカーが多数ある場合**：実素材のマーカーが5件だけだったため、数十〜数百件でのスクロール性能・種別絞り込みの体感は未計測。
- **【マーカー】同一種別・同一時刻のID衝突**：`markerId` に連番が無いため理論上起こりうるが、**実データでは未発生**。検出と編集不可はテストで固定したが、実プロジェクトで再現した確認はしていない。
- **【マーカー】未生成の種別**：実際に生成されるのは TOPIC / LAUGH / CHECK の3種だけ。KEY / SHORT / RETAKE / SPONSOR / OP / ED は型に定義があるだけで、**それらを含むプロジェクトでの動作は未確認**（DTO・検証・画面は9種すべて受けられるようにしてある）。
- **【マーカー】`syncMode: 'common'` での区間外マーカーの除外**：注意書きは出しているが、**実際に common モードで再出力して除外を確認した検証は未実施**。
- **【ショート候補】`edits.history` の肥大化**：1回の判断で最大7エントリ（6項目 + `candidateRange`）が追記される。候補が多く判断をやり直すほど `project.json` が膨らむが、**長期運用での実サイズは未計測**。履歴の間引き・圧縮は未実装。

---

## 7. 次のタスク

### 完了済み：Step 1 — GUI着手前の土台整理（2026-08-01）

Electron GUIの前提となる構成の整理を実施済み。**ロジックの変更は一切なし**（変更したソース72箇所はすべてimport指定子の文字列のみ）。

- クロスパッケージの相対パス越境を全廃し、workspace import（`@contentos/*`）へ移行
- 各 `package.json` の `exports` と `dependencies` を実態に合わせて整理（依存の向きが構造で強制される状態に）
- `tsup` によるビルド方式を整備し、素の `node` で `dist/` が動作することを実証
- 型チェック エラー0件・テスト462件すべてpassを維持（当時の件数）

詳細は「2. 現在のアーキテクチャ」の各サブセクションを参照。

### 完了済み：Step 2 — Electron骨組み + IPC（2026-08-01）

解析の「選択 → 開始 → 進捗 → 中止 → 完了 → フォルダを開く」までを1画面で操作できる最小構成。**`packages/*` のロジックは一切変更していない**（変更は `apps/desktop/` の新規追加と、ルートの `package.json` スクリプトのみ）。

- Main / Preload / Renderer / Shared DTO / 解析専用プロセス の5層に分離
- `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`。Preloadは7つのAPIだけを公開（★Step 2時点の数。Step 3〜8の追加を経て現在は36個）
- 解析は `child_process.fork` の別プロセスで実行（メインプロセスを塞がない）
- Rendererからの入力（パス・工程ID・同期モード・runId）をMain側で必ず検証
- 二重実行防止はElectron層のみで実装（`run-pipeline.ts` は無変更）
- テスト155件を追加（ffmpeg・faster-whisperは起動しない）

### 完了済み：Step 3 — 確認画面（字幕）（2026-08-03）

字幕の確認・修正・保存・部分再出力まで。**`packages/*` は今回も無変更**。

- 字幕一覧・低confidence語の強調・話者・信頼度・修正済み/競合/ID重複の表示
- 本文と話者の修正を `project.edits` にだけ保存（`analysis` は不変。実機で確認済み）
- `expectedUpdatedAt` による競合更新の検出（上書きしない）
- プレビュー音声の生成と `contentos-media://` による安全な再生
- 3工程だけの部分再出力（解析・文字起こし・同期をやり直さない）
- テスト140件を追加

### 完了済み：Step 4 — 字幕ID重複の解消（2026-08-03）

同じ開始時刻のキューでIDが衝突する問題を、**既存IDと既存editsを変えない形**で解消した。

- `subtitleId(startSec, occurrence)` と `assignSubtitleIds()` を追加（1件目は従来のID、2件目以降に連番）
- `timeFromId()` を先頭アンカーの照合に変更し、連番付きIDからも時刻を復元できるようにした
- `generate-subtitles` がゼロ長キューと開始時刻の重複を警告として報告
- 確認画面：一意なIDのキューは編集可能に。旧形式の重複IDは互換性のため引き続き編集拒否
- 重複IDに修正が付いている異常データを「要確認」として提示（自動で移し替えない）
- テスト45件を追加。実データのプロジェクトで移行を確認（衝突なし6件のIDは不変、孤立0件のまま）

### 完了済み：Step 5 — プロジェクト一覧・新規作成・素材登録（2026-08-04）

実運用の入口をGUIで成立させた。**`run-pipeline.ts`・キャッシュ方式・FCP7 XML生成は無変更**。

- プロジェクト一覧（参照情報だけをアプリ設定に保存。本体はproject.jsonのまま）
- 新規作成（`createProject()` をそのまま使用。既存フォルダを上書きしない）
- 素材登録（実ffprobeでメタデータ取得。**元素材は読むだけ**）
- 役割の自動推測は提案どまり。未確定のままでは解析させない
- 解析前チェックを error / warning に分離
- 既存の解析画面・字幕Reviewへそのまま接続
- テスト116件を追加

`packages/core` の `ASSET_ROLES` に `logo` を1件追加した（要求された素材種別のうち唯一存在しなかったため）。既存プロジェクトに `logo` の素材は無いので後方互換。

**コミット済み**：`ab322ff feat: add project setup and media registration workflow`（24ファイル / +4470行）。コミット前に型チェック・全テスト・ビルド・CLI回帰（`--help` が15工程を列挙）・Review回帰（196件）を実施し、元素材の非変更（`.selfcheck` のfixtureがmtime不変）と `project.analysis` / `project.edits` の非変更を確認済み。

### 完了済み：Step 6 — 確認画面（ショート候補）（2026-08-04）

ショート候補の確認・採否・編集・保存と、`shorts.csv` の部分再出力まで。**`packages/*` は1ファイルも変更していない**（差分はすべて `apps/desktop/` 内）。

- 採否（採用 / 不採用 / 未判断）・タイトル・冒頭フック・投稿文・ハッシュタグ・メモを `project.edits.shorts` にだけ保存（`analysis` は不変。実機で確認済み）
- `expectedUpdatedAt` による競合更新の検出（上書きしない）
- **再解析で判断が外れうる旨を常時警告**（Mainが文言を持ち、画面から消せない）
- 孤立した判断を**内容ごと**提示し、`project.json` からは消さない
- **`rangeChanged`**：IDが残ったまま区間が入れ替わる「静かな取り違え」を履歴から検出
- 再出力は `save-artifacts` + `save-project` の2工程のみ（**FCP7 XML は作り直さない**）
- テスト130件を追加

コミット：`7e37d07 feat: add short candidate review and adoption workflow`（19ファイル / +3888行）

### 完了済み：Step 7 — 確認画面（カメラ切替）（2026-08-05）

カメラの差し替え・時間軸の調整・カットの追加/削除/取り消しと、FCP7 XML の再出力まで。**`packages/*` は1ファイルも変更していない**。

- `edits.cameraShots` の3構造（`overrides` / `inserted` / `deletedIds`）すべてに対応
- **XMLを壊す入力を保存前に拒否**（未知カメラ・重なり・ゼロ長・尺超過・全削除）
- **再接続（`reattached`）を初めて画面に出した**（カメラIDは時刻を持つため日常的に発生する）
- 人が追加したカットは `shot-ins-` 接頭辞のIDと暫定 `reason: 'hold'`
- 再出力は字幕と同じ3工程。**`generate-premiere-xml` は必須**
- Renderer 側でも保存前に重なりを検出し、保存ボタンを押せなくする
- Step 7 の最初に `validate-common.ts` を切り出し（挙動は無変更・1048件を維持）
- テスト180件を追加

コミット：`4fa9f8d feat: add camera shot review with timeline-safe editing`（29ファイル / +5748行 −214行）

### 完了済み：Step 8 — 確認画面（マーカー）（2026-08-05）

マーカーの名前・コメントの修正、削除、取り消しと、FCP7 XML の再出力まで。**`packages/*` は1ファイルも変更していない**。

- **★IDの2系統を実測で確認**し、`volatileId`（CHECK系＝再解析で必ず外れる）を1件ずつ提示
- **CHECK の編集は禁止しない**。「永続化されない可能性」を編集画面で個別に警告したうえで使えるようにした
- **★種別またぎの再接続を検出**（章タイトルが笑いマーカーに乗る事故）。**自動では取り消さない**
- 名前は空を拒否・コメントは空を許可（`resolve.ts` の `??` フォールバックに由来する区別）
- 同一種別・同一時刻のID衝突は編集不可にする（字幕IDの重複と同じ扱い）
- 再出力は3工程。カメラ切替と同じく `generate-premiere-xml` が必須
- マーカーの追加・時刻/種別の変更は**データモデル上できない**ため未対応（検証で明示的に拒否）
- テスト144件を追加

コミット：`040822c feat: add marker review with volatile-id and kind-mismatch detection`（21ファイル / +4379行 −37行）

### 完了済み：Step 9 — 共通化リファクタリング（2026-08-09）

4画面（字幕・ショート候補・カメラ切替・マーカー）の重複を2ファイルに集約した。**`packages/*` は1ファイルも変更していない**。**テストは1件も追加・変更していない**（挙動を変えていないことの担保）。

- 新規 `main/review-common.ts`（169行）… 組み立て・保存の共通部品
- 新規 `renderer/review-shared.tsx`（297行）… 状態・表示部品・Hook
- **★挙動を1つも変えていない。** 返す値・エラーコード・文言・クラス名・状態遷移は移設前と1文字も同じ
- 集約した主な重複：`summaryOf`（4→1）/ `analysisNotReady`（4→1）/ `loadProject` の try/catch（8→1）/ 保存＋読み直し（4→1）/ ID検証（4→ファクトリ）/ 再出力IPCハンドラ（4→1）/ `SaveBadge`（4→1）/ 再生エリア・再生操作（4→1）/ 完了イベントの購読（4→1）/ `canExport`（4→1）/ 保存可能フェーズ判定（5→1）/ 状態の共通フィールドとフェーズunion（4→1）
- **★共通化しなかったもの（意図的）**：`persistAndReload` の結果の組み立て（1要素返却3画面 対 並び全体返却のカメラ＝Step 8 で決めた2系統の分割を維持）、各画面固有の検出ロジック、カメラ固有の `previewIssues` / `canInsert` / 重なりを理由に再出力を止める判定、State の `data`（画面ごとに型が違う）
- **★型の保証を落としていない。** 共通関数化で絞り込みが効かなくなる箇所を `!` で黙らせず、`loadForSave` は確かめた `analysis` を `project` と別フィールドで返す（参照はそのまま。詰め直すと保存対象が別オブジェクトになる）。`canExport` は `data` の有無を先に確かめる
- **★参照の安定性を移設前と揃えた。** `useReviewMedia` は戻り値を `useMemo`、`setMediaUrl` は useState のセッターそのもの。各画面は `setMediaUrl` / `seek` を分割代入して依存配列に入れており、依存配列が実態と一致している
- 検証：48ファイル / 1372件 全pass（**Step 8 と同数**）、型チェック エラー0件、ビルド成功、`git diff --check` clean、`selfcheck` 全12項目合格（xmllint によるXML妥当性・SRT出力を含む）
- `shared/ipc.ts` と `preload/` は**無変更** → 公開API36個（invoke 34 + event 2）維持
- 成果物（XML・SRT・CSV）の生成は `packages/editing` と `packages/pipeline` に閉じており `apps/desktop` 側に該当なし。その `packages/` が無変更のため成果物は一致する（`report.html` の生成日時のみ既存仕様で差分あり）

コミット：`87d7b82 refactor: extract shared review building blocks without behavior change`（25ファイル / +903行 −1222行 ＝ 正味 −319行）

### 完了済み：Step 10 — 復旧画面（Review Recovery）（2026-08-09）

4画面に散らばっていた「要確認」を1本の一覧にまとめ、**付け替え**と**破棄**をその場で行えるようにした。**`packages/*` は1ファイルも変更していない**。**既存4画面の Main・Renderer・状態遷移は1行も変更していない**（差分0行を確認済み）。

**★中核となる実測**（設計前に `packages/core` を実際に動かして確認）
`matchEdits` は**ID完全一致を時刻での再接続より先に**評価する。したがって `edits` のキーを実在IDへ移し替えるだけで、孤立した修正はその要素へ適用される（実測：orphaned 1→0、しかも `reattached` にも載らない＝「元からそのID宛」扱い）。付け替えはこの性質にだけ乗るので、凍結対象の `resolve.ts` に触れずに実装できる。自動再接続の許容範囲は **0.5秒ちょうどまで**（0.50→接続 / 0.51→孤立）。

**★対象5種は「横断」ではなく偏在していた**（実測で判明）

| 種別 | 字幕 | ショート | カメラ | マーカー |
|---|:---:|:---:|:---:|:---:|
| orphaned | ✓ | ✓ | ✓ | ✓ |
| reattached | ✓（★従来未表示） | 原理的に不可 | ✓ | ✓ |
| kindMismatch | — | — | — | ✓ |
| rangeChanged | — | ✓ | — | — |
| conflicted | ✓ | — | — | — |

4画面共通なのは `orphaned` だけ。一覧の主軸をそこに置き、他は同じ枠へ流し込む形にした。

- **★字幕の `reattached` を初めて可視化した。** `resolveProject` は字幕の繋ぎ直しも返しているが、`review.ts` は `ReattachedEditLike` を型宣言しているだけで一度も読んでいなかった。この画面では4ドメインを対称に扱うため `resolveProject` から直接作る（**既存の字幕画面の表示は変えていない**）。
- **★不変条件：`RecoveryItem.sourceId` は常に `edits` 側のキー。** `matchEdits` は edits を書き換えないので、繋ぎ直された後も修正は古いキーのまま保存されている。5種すべてでこれが成り立つため、「破棄」を4ドメイン×5種で1つの処理に書けている。
- **★責務は修復まで。再出力は持たない。** カメラ切替の整合性チェック（重なり・尺超過でXMLを壊さない）を迂回してしまうため、書き出しは各Review画面の責務のまま残す。
- **★「確認済み」の記録は持たない。** 記録するには `packages/core` の `EditsLayer` に新フィールドが要り、変更禁止の資産に手を入れることになる。
- **★Step 9 の共通部品をそのまま使い、追加は0件。** `SaveBadge` / `useReviewMedia` / `ReviewPlayer` / `usePipelineFinished` / `isSavablePhase` / `ReviewStateBase` / `loadForSave` / `saveAndRebuild` / `summaryOf` を無改造で流用。判定ロジックも写していない（4画面の `buildXxxData` を読むだけ。`timeFromId` も本体をそのまま使う）。

**★実機確認で見つけて直した3点**（テストだけでは出なかった）

1. 繋ぎ直し項目に時刻を載せていなかった。一覧が時刻順に並ばず、その項目だけ再生位置へ飛べなかった。
2. 判断を破棄したショートに「区間変化」が残り続けた。`rangeChanged` は `edits.history` から算出され、履歴は追記のみで消えないため、**破棄しても消えない項目**になっていた。判断が残っているものだけ出すようにした。
3. 戻るボタンの文言が既存4画面（「解析画面へ戻る」）と食い違っていた。

新規：`shared/recovery-dto.ts` / `shared/recovery-validate.ts` / `main/recovery.ts` / `renderer/recovery-state.ts` / `renderer/RecoveryScreen.tsx`

テスト83件を追加。合計 **52ファイル / 1455件 全pass**（既存1372件は無変更）。公開APIは4つ増えて **36 → 40**（invoke 38 + event 2）。

コミット：`e95c8f1 feat: add cross-screen recovery for orphaned and reattached edits`（16ファイル / +3644行 −1行）

### ★Step 11 の開始位置 — 書き出し画面

**Step 10 までで「解析 → 確認 → 修正 → 復旧」が一巡した。** 残っているのは、できあがった成果物を編集者へ渡す出口。

**なぜ次がここか**：現在、成果物（FCP7 XML・SRT3本・shorts.csv・youtube-chapters.txt・report.html）は `exports/` に書かれるだけで、**GUIからは所在も鮮度も分からない**。復旧画面で修正しても「どれを作り直せばよいか」は編集者の記憶頼りになっている。Step 10 が意図的に再出力を持たなかったぶん、ここが最後の空白になる。

**着手前に読むこと**

1. **成果物の一覧と鮮度**。`project.exports` に書き出し履歴がある（`packages/core` の `Project.exports`）。`edits.history` の最終更新と突き合わせれば「修正したのに再出力していない」を出せる。
2. **再出力の工程はすでに Main が固定している**。`ipc.ts` の `REVIEW_EXPORT_STEPS` / `SHORTS_EXPORT_STEPS` / `CAMERA_EXPORT_STEPS` / `MARKER_EXPORT_STEPS` と、Step 9 の `createExportHandler` がそのまま使える。**書き出し画面のために新しい工程を作らないこと。**
3. **★カメラの整合性チェックを迂回しないこと**。重なり・尺超過が残ったまま `generate-premiere-xml` を回すと Premiere プロジェクトが壊れる。`camera-state.ts` の `canExport` が持つ条件（`counts.overlaps === 0 && counts.outOfRange === 0`）を、書き出し画面でも必ず通す。
4. **共通部品は Step 9 の `review-shared.tsx` と `review-common.ts` を使う**。Step 10 は追加0件で作れた。ここでも `ReviewStateBase` / `isSavablePhase` / `SaveBadge` / `usePipelineFinished` が効くはず。
5. **`report.html` の生成日時だけは毎回変わる**（既存仕様）。成果物の同一性を比べるときはここを除外する。

**保留中の課題との関係**：「話者修正が成果物に届いていない」（後述）は書き出し画面を作ると**目に見える形で露出する**。`save-artifacts.ts` の変更＝成果物の中身が変わるため、Premiere実機検証が終わるまでは着手しない方針は維持し、画面には「未対応」と明示するのが安全。

### そのあと

- AI設定（ローカルモードで配線 → GeminiProvider）

※「プロジェクト一覧・素材登録画面」はStep 5、「ショート候補の採否」はStep 6、「カメラ切替の修正」はStep 7、「マーカー」はStep 8、「共通化」はStep 9、「復旧画面」はStep 10で実装済み。

**★保留中の課題**

- **話者修正が成果物に届いていない。** `edits` には保存されるが `subtitle.srt` / `speaker.srt` のどちらにも反映されない（前述）。反映には `save-artifacts.ts` が resolved subtitle の `speakerId` を使うように変える必要があり、**成果物の中身が変わる**。Premiere実機検証が終わるまで着手しない方針で保留中。
- **ゼロ長キュー。** 開始時刻の衝突を生む主因だが、時間軸を勝手に詰めない方針のため自動削除していない。現在は警告として報告するのみ。

---

## 8. 次回セッション開始時の確認コマンド

⚠️ **このリポジトリは git 管理下にある**（2026-08-04 時点）。

| 項目 | 値 |
|---|---|
| ブランチ | `main` |
| リモート | `origin` → https://github.com/okumura-hiyu-bit/workaholic-content-os |
| 最新コミット | `e95c8f1`（Step 10。push済み） |

ただし**親ディレクトリ `Cloude Code ファイル/` 自体も別のgitリポジトリ**（ブランチ `main`・コミット0件）になっており、リポジトリが入れ子になっている。**親も `main` なので `git branch` の表示だけでは見分けられない。** gitコマンドを打つ前に、必ず `workaholic-content-os/` に `cd` し、`git rev-parse --show-toplevel` で対象リポジトリを確かめること。特に `git add -A` は親リポジトリで実行すると `node_modules/` や `.venv/`、ホーム配下のファイルまで巻き込むため、**必ずパスを明示してステージする**こと。

```bash
# 1. 作業ディレクトリの確認（★親も別リポジトリなので必ずcdする）
cd "/Users/kishimototaishi/Desktop/Cloude Code ファイル/workaholic-content-os"

# 2. リポジトリと変更差分の確認
git status
git log --oneline -5
git diff --stat
# → 2026-08-09 時点の最新コミット（新しい順）：
#   e95c8f1 feat: add cross-screen recovery for orphaned and reattached edits ← Step 10
#   aa97640 docs: record Step 9 commit id
#   87d7b82 refactor: extract shared review building blocks without behavior change ← Step 9
#   f4f15ae docs: record Step 8 commit id
#   040822c feat: add marker review with volatile-id and kind-mismatch detection ← Step 8
#   89830b9 docs: record Step 7 commit id
#   4fa9f8d feat: add camera shot review with timeline-safe editing  ← Step 7
#   93a3066 docs: record Step 6 design decisions and refactoring candidates
#   7e37d07 feat: add short candidate review and adoption workflow    ← Step 6
#   ab322ff feat: add project setup and media registration workflow   ← Step 5
#   c7dd425 fix: ensure unique and backward-compatible subtitle IDs    ← Step 4
#   57af003 feat: add subtitle review and safe edit workflow           ← Step 3
#   e518367 feat: add Electron desktop pipeline control MVP            ← Step 2
#   dbe3033 refactor: establish workspace package boundaries and build pipeline ← Step 1

# origin と同期しているか（ahead/behind が出なければ同期済み）
git status -sb

# 3. 依存の導入（workspace のシンボリックリンクを張るため、clone直後は必須）
npm install
# → node_modules/@contentos/* が packages/* へのシンボリックリンクとして作られる。
#   これが無いと @contentos/* の import が解決できず、型チェックもテストも通らない。

# 4. 型チェック（エラー0件が正常）
npm run typecheck

# 5. 全テスト（本ファイル更新時点で 48 files / 1372 tests / 全pass）
npm test

# 6. ビルド（dist/ と apps/desktop/dist/ の生成。どちらも .gitignore 済み）
npm run build

# 4〜6 をまとめて実行する場合
npm run verify

# 7. Electronアプリの起動（★事前に npm run build が必要）
npm run desktop
# → 解析専用プロセスが dist/pipeline.js を読むため、ビルドしていないと
#   「解析エンジンがまだビルドされていません」と表示されて開始できない。
# → リポジトリの場所を明示したい場合は環境変数で指定する：
#   CONTENTOS_PROJECT_ROOT=/path/to/workaholic-content-os npm run desktop

# 8. 実機動作確認が必要な場合（ffmpeg・faster-whisperのセットアップ済みが前提）
npm run selfcheck
# → .selfcheck/検証素材 fixture/ に合成素材が再生成される。
#   その後 cli/src/pipeline.ts 用の project.json を作れば実機パイプライン検証を再現できる
#   （具体的な組み立て方は本ファイル「5. 現在のテスト状況」を参照）。
```

---

## 9. 変更禁止事項（次回セッションが厳守すること）

- **Premiere実機検証が終わるまで、既存のFCP7 XML生成方式（`packages/editing/src/fcp7xml.ts`・`build-project.ts`）を大幅に変更しないこと。** 検証結果が届くまでは構造を維持する。
- **既存の人間修正レイヤー（`packages/core/src/resolve.ts`）、パイプライン（`packages/pipeline/src/run-pipeline.ts`）、キャッシュ方式（ハッシュ連鎖によるスキップ判定）を、Electronの都合で書き換えないこと。** GUI側の要求でこれらのコア設計を変えたくなった場合は、まずユーザーに相談する。
- **GUIから`packages/pipeline`を呼ぶ構造にし、`packages`側から Electron や React を import しないこと。** 依存の向きは常に `apps/desktop → packages/pipeline → packages/{editing,media,ai} → packages/core` の一方向。
- **パッケージをまたぐ参照に相対パス（`'../../core/src/...'`）を使わないこと。** 必ず workspace import（`@contentos/core/project` 等）を使う。新しいモジュールを他パッケージから参照したくなったら、まず対象の `package.json` の `exports` に追加する。ここを崩すと依存の向きがツールで検出できなくなる。
- **`dist/` をGitにコミットしないこと。** ビルド生成物であり `.gitignore` 済み。手で編集もしない。`apps/desktop/dist/` も同様。
- **Electronのセキュリティ設定を緩めないこと。** `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` は固定。Rendererに `ipcRenderer` / `fs` / `child_process` / 任意コマンド実行 / 任意パスの読み書き / APIキーを渡さない。Preloadが公開するAPIを増やすときは `apps/desktop/src/preload/api.ts` の `ALLOWED_API_KEYS` も更新する（テストが完全一致を確認している）。
- **`runPipeline()` をElectronメインプロセスで直接実行しないこと。** 同期のCPU集約処理でウィンドウが固まる。必ず解析専用プロセス経由にする。
- **`TranscribeConfig`（`packages/pipeline/src/types.ts`）に項目を足さないこと。** `stepConfigSlice('transcribe')` がこのオブジェクトを丸ごとキャッシュキーにしているため、項目を足すと文字起こしのキャッシュが無効化され、CLIとGUIでキャッシュを共有できなくなる。
- **Rendererへ `technicalMessage` や stack trace を渡さないこと。** 必ず `toSafeError()` を通す。開発者向け情報は構造化ログにのみ残す。
- **確認画面から `project.analysis` を書き換えないこと。** 人間の修正は `project.edits` にだけ書く。表示値は必ず `resolveProject()` に作らせ、独自の突き合わせロジックを増やさない。履歴は `recordEdit()` で残す。
- **保存時の `expectedUpdatedAt` の照合を外さないこと。** 別ウィンドウやCLIが同じ project.json を更新している可能性があるため、食い違ったら上書きせず競合として返す。
- **Rendererに絶対パスやファイルアクセスを渡さないこと。** 再生用メディアは `contentos-media://<token>` のみ。トークンは Main が明示的に登録したパスにしか解決しない。
- **ショート候補の再出力に `generate-premiere-xml` を足さないこと。** ショート候補は FCP7 XML に含まれないため動かす理由がなく、動かせば Premiere実機検証の対象である成果物を無用に作り直すことになる（`SHORTS_EXPORT_STEPS`）。
- **`REANALYSIS_WARNING` / `FIELDS_NOT_EXPORTED` を Renderer 側のフラグで消せるようにしないこと。** どちらも実装で回避できない性質を編集者に知らせるもので、Main が本文を持ち DTO に必ず載せる設計になっている。
- **マーカーの再出力から `generate-premiere-xml` を外さないこと。** カメラ切替と同じ理由（`save-artifacts` は `analysis.markers` の件数しか使わない）。
- **CHECK マーカー（`volatileId`）の編集を禁止しないこと。** 一時的な確認メモとして使う運用を前提に、警告したうえで許可する方針を採っている。代わりに `volatileId` をDTOから外したり、画面の個別警告を消したりしないこと。
- **種別またぎの再接続（`reattachedKindMismatch`）を自動で取り消さないこと。** 検出して提示するまでが役割で、判断は人が行う（ショートの `rangeChanged`・カメラの `reattached` と同じ思想）。
- **マーカーIDの検証を時刻キー形式だけに狭めないこと。** CHECK は `mk-CHECK-<check.id>` という別系統で、実データでは過半を占める。狭めると大半のマーカーが編集できなくなる。
- **カメラ切替の再出力から `generate-premiere-xml` を外さないこと。** カメラ修正が反映される成果物は FCP7 XML だけで、`save-artifacts` が書く SRT・CSV・レポートには一切出ない。外すと修正がどこにも反映されない（`CAMERA_EXPORT_STEPS`）。
- **カメラ切替の検証層（`camera-validate.ts` / `camera.ts` の `assertTimelineSafe`）を緩めないこと。** `build-project.ts`（凍結対象）は未知の `cameraId` で例外を投げ、ゼロ長カットを黙って捨て、重なりを検査しない。この層が最後の砦になっている。
- **`cameraId` を `asset.id` と取り違えないこと。** `generate-premiere-xml.ts` が `videos` を `{ id: a.role }` で組み立てているため、実体は **role**（`wide` / `cam_A`）。
- **人が追加したカットの変更を `overrides` に書かないこと。** `overrides` は解析側のIDにしか当たらない（`resolve.ts` の `matchEdits`）。`inserted` の中身を直接直す。
- **`edits.history` の `field: 'candidateRange'` を人向けの履歴表示に混ぜないこと。** これは人の操作の記録ではなく、区間の取り違えを検出するためのシステム内部の値。履歴を画面に出す実装を作るときは除外する。

---

## 10. 今後のリファクタリング候補（★実装しないこと。着手判断は都度ユーザーに確認する）

Step 8 完了時点（2026-08-05）の状況。**★4画面（字幕・ショート・カメラ・マーカー）が出そろい、共通項が確定した。次フェーズで実施する。**

> **【2026-08-09 追記】この節の「共通化フェーズ（Step 9）」は `87d7b82` で実施済み。**
> 以下の方針（独立コミット・機能追加と混ぜない・`persistAndReload` の2系統分割）は
> すべてそのまま守られている。**設計の根拠として残すが、再実施はしないこと。**
> 実際に何をどこへ集約したかは「7. 実装の進捗」の「完了済み：Step 9」を参照。

### ★共通化フェーズ（Step 9）の進め方 — 着手前に必ず読むこと（★実施済み）

**1. 共通化は Step 9 として独立したコミットで実施する。**
Step 1〜8 のように「機能を作るついでに整理する」形にはしない。共通化だけを行うコミットを切る。

**2. ★機能追加と共通化を同じコミットに混ぜない。**
理由：混ぜると回帰が起きたときに「新機能の実装が原因か、共通化が原因か」を切り分けられなくなる。特にカメラ切替とマーカーは FCP7 XML を書き換えるため、壊れたときの影響が Premiere プロジェクトそのものに及ぶ。共通化のコミットでは**テスト件数と全pass、および4画面すべての実機確認が Step 8 時点と同じ結果になること**を条件とする（＝挙動を1つも変えない）。

**3. ★`persistAndReload` は2系統に分ける方針を維持する。**

| 系統 | 画面 | 戻り値 | 理由 |
|---|---|---|---|
| **1要素返却** | Subtitle / Shorts / **Marker** | 更新した1件 | 要素同士が干渉しない |
| **並び全体返却** | **Camera** | 並び全体 | 追加・削除・時間変更が隣の要素の重なり・隙間を変えるため、1件だけ返すと画面の整合性表示が古いままになる |

3対1なので、**1要素返却型を共通基盤にし、Camera だけ別実装として残す**。無理に1つへまとめないこと。まとめると Camera の都合（並び全体・重なり検査）が共通基盤に流れ込み、他の3画面が持つ必要のない複雑さを背負う。

この2系統の区別は Camera 実装時点では見えておらず、**Marker を作って初めて確定した**。Step 9 ではこの分割を前提に設計する。



**進捗：優先度Aのうち「validate の依存方向」は Step 7 の最初に解消済み。**
`validate-common.ts` を新設し、`invalid()` / `CONTROL_CHARS` / `validateExpectedUpdatedAt` / `validateTimeSec` / `validateSingleLineText` / `validateMultiLineText` / `conflictError()` を集約した。字幕・ショート・カメラ・素材登録のすべてがここを見る。**挙動は無変更**（テストも `validate-common.test.ts` へ移設しただけで件数は1048のまま維持）。`review-validate.ts` は字幕固有の検証だけを持つ状態になった。

**残りは未実施。** Step 7・8 では設計を固定するため、他の共通化はあえて行っていない。

★4画面を並べて分かった最重要の事実：**`persistAndReload` は「1要素を返す」型と「並び全体を返す」型に分かれる。**

| 画面 | 保存結果 | 理由 |
|---|---|---|
| 字幕 / ショート / **マーカー** | **1要素** | 要素同士が干渉しない |
| カメラ切替 | **並び全体** | 追加・削除・時間変更が隣の要素の重なり・隙間を変える |

**3対1なので、前者を共通基盤にしてカメラだけ別実装**にするのが素直。これは Camera 実装時には見えていなかった情報で、Marker を作って初めて確定した。

もう1つ確定したこと：`summaryOf` / `loadProject` の try/catch / 競合検出は**4画面すべてで同型**。カメラの `loadForSave()`（マーカーでも同じ形を採用）が良い前例になっている。

### 優先度A：依存の向きと命名（3画面目の前に直す価値が高い）

| 項目 | 現状 | 問題 | 案 |
|---|---|---|---|
| ~~validate の依存方向~~ | ✅ **Step 7 で解消済み**（`validate-common.ts`） | — | — |
| `main/review.ts` | 実体は**字幕Review専用**なのに総称的な名前。しかも `shorts.ts` と `camera.ts` が型と `normalizeAnalysis` をここから import している | 「ショート・カメラが字幕に依存している」ように読める | `subtitle-review.ts` へ改名し、共有部分を `review-common.ts` へ抜く |
| `ReviewDeps` | 字幕・ショート・カメラ共通の依存になったが名前は Review のまま | 4画面目で更に実態とずれる | `ProjectEditDeps` 等 |
| `countsOf` | `review.ts`（private）・`shorts.ts`・`camera.ts`・`marker.ts` に**同名で別シグネチャが4つ** | まとめるとき衝突する | 共通化 or 改名 |
| `EditsLike` の必須フィールド | 画面が増えるたびに `subtitles` → `+shorts` → `+cameraShots` → `+markers` と必須項目が増える | fixture もそのたび更新が要る | 最小契約にして各画面が narrow する |
| `main/review.ts` からの型import | `shorts.ts` / `camera.ts` / `marker.ts` の**3つ**が依存している | 依存の向きが実態と食い違う | `review-common.ts` へ抜く |

### 優先度B：層ごとの重複（実測値）

**Main**

| 対象 | 重複の程度 | 2画面 → 4画面 |
|---|---|---|
| `summaryOf()` | **4ファイルで書式以外バイト一致** | 12行 ×4 |
| `persistAndReload()` | ★**3対1に分かれる**（字幕・ショート・マーカー＝1要素／カメラ＝並び全体）。前者を共通化しカメラは別実装が素直 | 35行 ×4（要設計） |
| `loadProject` の try/catch → `INVALID_PROJECT` | 字幕3・ショート3・カメラ1・マーカー1（後2つは `loadForSave` に集約済み） | 8箇所 |
| 競合検出 `updatedAt !== expectedUpdatedAt` | 字幕2・ショート2・カメラ1・マーカー1 | 6箇所。★`loadForSave` が良い前例 |
| `toOrphaned()` | `kind` で filter して edit の中身を写す形が同一。差は「どのフィールドを写すか」だけ | 20行 ×4 |
| `normalizeAnalysis()` | **既に共有済み**（`review.ts` から export）。良い前例 | — |

**IPC**

| 対象 | 重複の程度 |
|---|---|
| `reviewExport` / `shortsExport` | **差分は工程定数1つとコメントのみ**（約35行）。`createExportHandler(steps)` のファクトリで完全に吸収できる |
| load ハンドラ | `validateProjectPath` → `readProjectSummary` → `build*Data` の3段が同型 |
| update ハンドラ | `validate*Request` → `readProjectSummary` → `apply*` の3段が同型 |

**Renderer（状態）**

| 対象 | 重複の程度 |
|---|---|
| `canSave` / `canExport` | **型名以外が完全一致** |
| `export/finished` case | **バイト一致** |
| reducer の case | 14中**10個が実質同一**（`load/started` `load/failed` `draft/discarded` `save/started` `save/conflicted` `save/failed` `export/started` `export/finished` `playhead/moved` ＋ `save/succeeded` の骨格） |
| `ReviewState` / `ShortsState` | 11フィールド中**9つが共通** |

**Renderer（画面）**

| 対象 | 重複の程度 |
|---|---|
| 再生エリア（`<audio>` + プレイヤー操作） | **約50行が書式以外一致** |
| `SaveBadge` | 型名以外一致 |
| `seek` / `togglePlay` / `prepareMedia` | ロジック同一 |
| `onPipelineFinished` 購読 useEffect | 同一 |
| loading / failed の早期 return、競合バナー、エラーバナー | 文言以外同一 |

**DTO**

| 対象 | 重複の程度 |
|---|---|
| `ReviewMedia` | shorts-dto が**インラインで再定義**（構造的重複） |
| 保存結果の union | `{ok:true; updatedAt; <item>; counts} \| {ok:false;conflict:true;error} \| {ok:false;conflict?:false;error}` が同型 |
| `*ExportRequest` / `*ExportResult` / `*LoadResult` | 同型 |

**Validation**

| 対象 | 重複の程度 |
|---|---|
| `invalid()` ヘルパ | 両ファイルに重複 |
| 制御文字の正規表現 | **2箇所で二重定義**（review 側はインライン、shorts 側は定数） |
| ID検証 | IDの形式は種別ごとに違うので**共有すべきでない**。ただし「正規表現＋文言」を包む薄いファクトリは切り出せる |

### 優先度C：共通化の具体案

**共通Hook**

| 候補 | 吸収できるもの |
|---|---|
| `useReviewMedia(projectPath)` | `mediaUrl` / `mediaNote` / `audioRef` / `seek` / `togglePlay` / `prepareMedia` ＋ 再生エリアJSX |
| `useReviewExport(dispatch, load)` | `onPipelineFinished` 購読 ＋ 購読解除 ＋ `export/started` ディスパッチ |
| `useProjectReview<TData>({ load, save })` | load→dispatch→エラー分岐、`conflict === true` の振り分け |

**共通Reducer**：`createReviewReducer<TData, TItem, TDraft>({ itemsOf, draftOf, isDraftChanged })` のファクトリ。上表の10 case をベースが持ち、画面固有の case（`filter/changed` 等）だけ拡張で足す。`canSave` / `canExport` は `ReviewStateBase` を引数にすれば1本で済む。

**共通DTO**：`ReviewMediaDto` / `ReviewLoadResult<TData>` / `ReviewSaveResult<TItem, TCounts>` / `ReviewExportRequest` / `ReviewExportResult` / `ReviewCountsBase { edited; orphaned }`。

**共通Validation**：`validate-common.ts` に `invalid()` / `CONTROL_CHARS` / `validateExpectedUpdatedAt` / `validateTimeSec` / `validateSingleLineText` / `validateMultiLineText` / `createIdValidator(pattern, label)` を集約。

### 優先度D：細かい改善

- **`edits.history` の2用途**：`candidateRange` は人の操作ではなくシステムの内部状態。履歴を人向けに表示する実装では除外が必要（§9に明記済み）。
- **`ShortsScreen.tsx` の `tagText` 二重管理**：ローカル state と reducer の `draft.hashtags` が二重。入力途中の空行を消さないための実装だが、reducer 側に生文字列を持たせれば状態が一箇所にまとまる。
- **`applyField` の比較**：`JSON.stringify(before ?? null) === JSON.stringify(after ?? null)` は意図が読みにくく、`undefined`/`null` の正規化が2重。`isSameDecisionValue()` に切り出すと明確になる。
- **不要な export**：`shorts.ts` の `decidedRanges` は外部参照0（内部専用）。`countsOf` も外部参照0。export を外すか、テストで使うかに寄せる。
- **Main に UI 文言がある**：`REANALYSIS_WARNING` / `FIELDS_NOT_EXPORTED`。**意図的な設計**（画面から消せないことを保証するため）だが、文言だけを変えたい場合も Main を直すことになるトレードオフがある。
