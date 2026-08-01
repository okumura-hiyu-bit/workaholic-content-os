# CURRENT STATE — 引き継ぎドキュメント

> 作成日: 2026-07-30 / 最終更新: 2026-08-01（Step 1「GUI着手前の土台整理」を反映）。この内容は会話の要約ではなく、**実際のリポジトリ・テスト結果・型チェック結果を根拠に**作成しています。数値は必ず次回セッション側でも再確認してください（本ファイル末尾のコマンド）。

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

モノレポ構成（npm workspaces）。`package.json` の `workspaces`: `["packages/*", "workers/*", "cli", "apps/*"]`（`apps/` は未作成＝Electron未着手）。

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
tsup.config.ts                 … Electronメインプロセス向けのビルド定義
dist/                           … ★ビルド生成物。.gitignore済み（Git管理対象外・手で編集しない）
```

### 依存方向（★一方向。これを崩さない）

```
cli/pipeline.ts ─┐
                  ├→ packages/pipeline → packages/{editing, media, ai} → packages/core
（将来）apps/desktop ─┘
```

- `packages/core` は他のどのpackageにも依存しない（末端）。ただし `packages/core/src/project.ts` だけは `packages/editing` を参照する例外的な逆依存を持つ（`build-project.ts` の型 `SyncMode`、および `types.ts` の `CameraShot`・`Speaker`・`Word` 等7つ）。いずれも `import type` のみで、ロジック依存ではない。
- `packages/pipeline` は React・Electron・DOM を一切importしない（`packages/pipeline/src/index.ts` のコメントに明記）。CLIからも将来のElectronメインプロセスからも同じ関数（`runPipeline()`）を呼ぶだけで完結する。
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

### ★Electronから呼ぶときの必須事項：projectRoot を明示する

`scripts/transcribe.py` と `.venv` のパスは `packages/media/src/transcribe.ts` で **`opt.projectRoot ?? process.cwd()`** から解決している。

CLIはリポジトリルートで実行されるため `process.cwd()` で問題なかったが、**Electronアプリのcwdはリポジトリルートではない**。GUIから解析を呼ぶときは `projectRoot` を明示的に渡さないと、文字起こし工程がPythonブリッジと仮想環境を見つけられずに失敗する。

なお `import.meta` はコード全体で未使用のため、バンドルしてもモジュール位置に依存したパス解決が壊れることはない（確認済み）。

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
Test Files  19 passed (19)
     Tests  462 passed (462)
```

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
- **workspace import 移行後（2026-08-01）に再確認した内容**：型チェック エラー0件、テスト 19ファイル/462件すべてpass（移行前と同一件数）、`npm run pipeline -- --help` が15工程を正常に列挙、`npm run build` 成功。加えて **`--experimental-strip-types` を付けない素の `node` で `dist/pipeline.js`・`dist/core.js` を読み込み、`runPipeline` の取得・15工程の確認・`createProject()`／`resolveProject()` の実行に成功**（＝Electronメインプロセスから解析を呼べることの前提条件を実証済み）。

---

## 6. 未検証事項

- **Premiere ProでのXML実機確認**：`xmllint`での構文妥当性は確認済みだが、実際にPremiere Proで読み込み・素材リンク・マーカー表示・音声トラック構成（原音有効／補正音ミュート）が意図通りかは**未検証**。ユーザー側での検証待ち（`docs/measurements/premiere-check-guide.md`参照）。
- **長尺の実素材**：これまでの検証は7.5秒（TTS音声）・40秒（合成fixture）のみ。10分規模の実収録での処理時間・メモリ使用量・文字起こし精度は未計測。
- **実素材での笑い・話者判定精度**：`speaker-detect.ts`の閾値は合成波形（正弦波ベース）でチューニングしたもので、実際の人間の声・実際の笑い声での精度は未確認。
- **同一プロジェクトの同時実行**：排他制御（ロック機構）は未実装。複数プロセスから同じプロジェクトに対して同時に`runPipeline()`を呼んだ場合の挙動は未定義・未検証。
- **実際の容量不足・権限エラー**：`PipelineErrors.diskFull`・`PipelineErrors.permissionDenied`はエラーメッセージとして実装済みだが、実際にディスク容量を枯渇させた状態・書き込み権限を剥奪した状態でのテストは未実施。
- **Gemini / OpenAIの本接続**：`packages/ai`はインターフェース・コスト計算・ローカルモードのみ実装。実際のAPI呼び出し（`GeminiProvider`等）は未実装。
- **Electron GUI**：`apps/`ディレクトリ自体が未作成。設計（`docs/13-gui-mvp.md`）のみ存在。
- **低解像度プレビュー生成**：確認画面が必要とする音声のみ／低解像度プレビューの書き出し機能は未実装（設計ドキュメントに記載のみ）。

---

## 7. 次のタスク

### 完了済み：Step 1 — GUI着手前の土台整理（2026-08-01）

Electron GUIの前提となる構成の整理を実施済み。**ロジックの変更は一切なし**（変更したソース72箇所はすべてimport指定子の文字列のみ）。

- クロスパッケージの相対パス越境を全廃し、workspace import（`@contentos/*`）へ移行
- 各 `package.json` の `exports` と `dependencies` を実態に合わせて整理（依存の向きが構造で強制される状態に）
- `tsup` によるビルド方式を整備し、素の `node` で `dist/` が動作することを実証
- 型チェック エラー0件・テスト462件すべてpassを維持

詳細は「2. 現在のアーキテクチャ」の各サブセクションを参照。

### 次の実装：Electron GUIのMVP（未着手）

以下は着手順の目安。

1. Electron + React + TypeScriptの骨組み（`apps/desktop/`を新設）
2. main / preload / rendererの分離
3. `contextIsolation: true`
4. `nodeIntegration: false`
5. pipeline IPCブリッジ（メインプロセスから`packages/pipeline`の`runPipeline()`を呼ぶ）
6. `ProgressEvent`のレンダラーへの転送（IPC経由）
7. `AbortController`による解析中止（レンダラーの「中止」ボタン→メインプロセス→`runPipeline`のsignal）
8. プロジェクト一覧画面
9. 素材登録画面
10. 解析進捗画面
11. 確認画面（★最も価値が高い画面。字幕・カメラ切替・ショート候補の修正UI）
12. 書き出し画面

---

## 8. 次回セッション開始時の確認コマンド

⚠️ **このリポジトリは git 管理下にある**（2026-08-01 時点。ブランチ `master`）。ただし**親ディレクトリ `Cloude Code ファイル/` 自体も別のgitリポジトリ**（ブランチ `main`・コミット0件）になっており、リポジトリが入れ子になっている。gitコマンドを打つ前に、必ず `workaholic-content-os/` に `cd` してから実行し、対象リポジトリを取り違えないこと。

```bash
# 1. 作業ディレクトリの確認（★親も別リポジトリなので必ずcdする）
cd "/Users/kishimototaishi/Desktop/Cloude Code ファイル/workaholic-content-os"

# 2. リポジトリと変更差分の確認
git status
git log --oneline -5
git diff --stat

# 3. 依存の導入（workspace のシンボリックリンクを張るため、clone直後は必須）
npm install
# → node_modules/@contentos/* が packages/* へのシンボリックリンクとして作られる。
#   これが無いと @contentos/* の import が解決できず、型チェックもテストも通らない。

# 4. 型チェック（エラー0件が正常）
npm run typecheck

# 5. 全テスト（本ファイル更新時点で 19 files / 462 tests / 全pass）
npm test

# 6. ビルド（Electron向けJSの生成。dist/ は .gitignore 済み）
npm run build

# 4〜6 をまとめて実行する場合
npm run verify

# 7. 実機動作確認が必要な場合（ffmpeg・faster-whisperのセットアップ済みが前提）
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
- **`dist/` をGitにコミットしないこと。** ビルド生成物であり `.gitignore` 済み。手で編集もしない。
