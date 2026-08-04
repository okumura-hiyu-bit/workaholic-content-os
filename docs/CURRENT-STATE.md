# CURRENT STATE — 引き継ぎドキュメント

> 作成日: 2026-07-30 / 最終更新: 2026-08-04（Step 1「土台整理」、Step 2「Electron骨組み + IPC」、Step 3「確認画面：字幕」、Step 4「字幕ID重複の解消」、Step 5「プロジェクト一覧・新規作成・素材登録」を反映）。この内容は会話の要約ではなく、**実際のリポジトリ・テスト結果・型チェック結果を根拠に**作成しています。数値は必ず次回セッション側でも再確認してください（本ファイル末尾のコマンド）。
>
> **Step 1〜5はすべてコミット済み**（最新: `ab322ff`）。ワーキングツリーに未コミットの実装は残っていません。

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
| Preload | `contextBridge` で21個のAPIだけを公開 | `ipcRenderer` / `fs` / `child_process` を渡さない |
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
Test Files  38 passed (38)
     Tests  918 passed (918)
```

内訳：コア 498件（21ファイル）＋ Electron 420件（17ファイル）。Electronのテストは ffmpeg・faster-whisper を一切起動せず、解析専用プロセスの起動関数を差し替えて検証している。

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
- **workspace import 移行後（2026-08-01）に再確認した内容**：型チェック エラー0件、テスト 19ファイル/462件すべてpass（★当時の件数。移行前と同一で、移行がロジックを変えていないことの根拠。現在は38ファイル/918件）、`npm run pipeline -- --help` が15工程を正常に列挙、`npm run build` 成功。加えて **`--experimental-strip-types` を付けない素の `node` で `dist/pipeline.js`・`dist/core.js` を読み込み、`runPipeline` の取得・15工程の確認・`createProject()`／`resolveProject()` の実行に成功**（＝Electronメインプロセスから解析を呼べることの前提条件を実証済み）。
- **Electron実機確認（2026-08-01）**：`.selfcheck` のfixtureから作った実プロジェクト（5素材・40秒）に対して、**実際にElectronアプリを起動し、Chrome DevTools Protocol でRendererを操作して**以下を確認した。
  1. アプリ起動・ウィンドウ生成・Reactのマウント（未選択画面の描画）
  2. `window.contentOs` が公開しているキーがちょうど7つ（`selectProject` / `readProjectSummary` / `startPipeline` / `cancelPipeline` / `openProjectFolder` / `onPipelineProgress` / `onPipelineFinished`）**※これは2026-08-01時点の記録。現在は21個**（Step 3で5個、Step 5で9個を追加。最新の一覧は `preload/api.ts` の `ALLOWED_API_KEYS` が唯一の正）
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
- `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`。Preloadは7つのAPIだけを公開（★Step 2時点の数。Step 3・Step 5の追加を経て現在は21個）
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

### 次の実装

1. **確認画面 — カメラ切替の修正**（`edits.cameraShots` は `overrides` / `inserted` / `deletedIds` の3構造。字幕より複雑）
2. **確認画面 — ショート候補の採否**（`edits.shorts`。IDに時刻を含まないため、候補が変われば必ず `orphaned` になる仕様）
3. **孤立修正の再接続UI**（現在は一覧表示のみ。「この修正をこのキューに付け直す」操作はまだ無い）
4. 書き出し画面
5. AI設定（ローカルモードで配線 → GeminiProvider）

※「プロジェクト一覧・素材登録画面」はStep 5で実装済み（`project.json` を直接選ぶ方式は残してあるが、既定の入口は一覧になった）。

**★保留中の課題**

- **話者修正が成果物に届いていない。** `edits` には保存されるが `subtitle.srt` / `speaker.srt` のどちらにも反映されない（前述）。反映には `save-artifacts.ts` が resolved subtitle の `speakerId` を使うように変える必要があり、**成果物の中身が変わる**。Premiere実機検証が終わるまで着手しない方針で保留中。
- **ゼロ長キュー。** 開始時刻の衝突を生む主因だが、時間軸を勝手に詰めない方針のため自動削除していない。現在は警告として報告するのみ。

---

## 8. 次回セッション開始時の確認コマンド

⚠️ **このリポジトリは git 管理下にある**（2026-08-04 時点。ブランチ `master`・リモート未設定）。ただし**親ディレクトリ `Cloude Code ファイル/` 自体も別のgitリポジトリ**（ブランチ `main`・コミット0件）になっており、リポジトリが入れ子になっている。gitコマンドを打つ前に、必ず `workaholic-content-os/` に `cd` してから実行し、対象リポジトリを取り違えないこと。特に `git add -A` は親リポジトリで実行すると `node_modules/` や `.venv/`、ホーム配下のファイルまで巻き込むため、**必ずパスを明示してステージする**こと。

```bash
# 1. 作業ディレクトリの確認（★親も別リポジトリなので必ずcdする）
cd "/Users/kishimototaishi/Desktop/Cloude Code ファイル/workaholic-content-os"

# 2. リポジトリと変更差分の確認
git status
git log --oneline -5
git diff --stat
# → 2026-08-04 時点の最新5件（この5件がStep 1〜5に対応する）：
#   ab322ff feat: add project setup and media registration workflow   ← Step 5
#   c7dd425 fix: ensure unique and backward-compatible subtitle IDs    ← Step 4
#   57af003 feat: add subtitle review and safe edit workflow           ← Step 3
#   e518367 feat: add Electron desktop pipeline control MVP            ← Step 2
#   dbe3033 refactor: establish workspace package boundaries and build pipeline ← Step 1

# 3. 依存の導入（workspace のシンボリックリンクを張るため、clone直後は必須）
npm install
# → node_modules/@contentos/* が packages/* へのシンボリックリンクとして作られる。
#   これが無いと @contentos/* の import が解決できず、型チェックもテストも通らない。

# 4. 型チェック（エラー0件が正常）
npm run typecheck

# 5. 全テスト（本ファイル更新時点で 38 files / 918 tests / 全pass）
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
