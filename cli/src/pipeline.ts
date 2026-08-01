/**
 * パイプラインをターミナルから実行する（GUI導入前の検証用）。
 *
 * 使い方:
 *   npm run pipeline -- --project "/absolute/path/to/projectDir"
 *   npm run pipeline -- --project ".../project.json" --from transcribe --to generate-premiere-xml
 *   npm run pipeline -- --project "..." --force
 *   npm run pipeline -- --project "..." --sync-mode common
 *   npm run pipeline -- --project "..." --json-progress
 *
 * --json-progress では、Electronからも読める1行1JSON形式で進捗を
 * 標準出力する。通常モードでは人が読みやすい表示にする。
 *
 * ★このファイルはUIロジックを一切持たない。packages/pipeline の
 * runPipeline() を呼び、結果を表示するだけ。
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import { loadProject } from '@contentos/core/project-store';
import {
  PIPELINE_STEP_IDS,
  PIPELINE_STEP_LABELS,
  runPipeline,
  type PipelineStepId,
  type ProgressEvent,
  type RunPipelineOptions,
} from '@contentos/pipeline';

interface ParsedArgs {
  projectDir: string;
  fromStep?: PipelineStepId;
  toStep?: PipelineStepId;
  onlySteps?: PipelineStepId[];
  force: boolean | PipelineStepId[];
  syncMode?: 'preserve' | 'common';
  model?: string;
  jsonProgress: boolean;
  help: boolean;
}

function isStepId(value: string): value is PipelineStepId {
  return (PIPELINE_STEP_IDS as readonly string[]).includes(value);
}

function requireStepId(flag: string, value: string | undefined): PipelineStepId {
  if (!value || !isStepId(value)) {
    throw new Error(
      `${flag} には工程IDを指定してください（例: transcribe）。指定可能: ${PIPELINE_STEP_IDS.join(', ')}`,
    );
  }
  return value;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = {
    projectDir: '',
    force: false,
    jsonProgress: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--project':
        args.projectDir = argv[++i] ?? '';
        break;
      case '--from':
        args.fromStep = requireStepId('--from', argv[++i]);
        break;
      case '--to':
        args.toStep = requireStepId('--to', argv[++i]);
        break;
      case '--only': {
        const value = argv[++i] ?? '';
        args.onlySteps = value.split(',').map((s) => requireStepId('--only', s.trim()));
        break;
      }
      case '--force': {
        // 次の引数が工程IDのカンマ区切りなら「指定工程だけ強制」、
        // それ以外（無い/次が別のフラグ）なら「全工程を強制」。
        const next = argv[i + 1];
        if (next && !next.startsWith('--') && next.split(',').every(isStepId)) {
          args.force = next.split(',') as PipelineStepId[];
          i++;
        } else {
          args.force = true;
        }
        break;
      }
      case '--sync-mode': {
        const value = argv[++i];
        if (value !== 'preserve' && value !== 'common') {
          throw new Error('--sync-mode は preserve か common を指定してください');
        }
        args.syncMode = value;
        break;
      }
      case '--model':
        args.model = argv[++i];
        break;
      case '--json-progress':
        args.jsonProgress = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`未知のオプションです: ${arg}`);
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`使い方:
  npm run pipeline -- --project <プロジェクトディレクトリ or project.json> [オプション]

オプション:
  --from <step>          この工程から実行する
  --to <step>            この工程まで実行する
  --only <step,step,...> 指定した工程だけ実行する（依存の完了は必須）
  --force [step,step,...] 全工程 or 指定工程を強制的に再実行する
  --sync-mode <mode>      preserve | common
  --model <name>          文字起こしモデル（既定 large-v3）
  --json-progress         進捗を1行1JSONで標準出力する（GUI/Electron用）
  --help                  このヘルプを表示する

工程ID:
  ${PIPELINE_STEP_IDS.join('\n  ')}
`);
}

function resolveProjectDir(input: string): string {
  if (!input) throw new Error('--project を指定してください');
  const absolute = isAbsolute(input) ? input : resolve(process.cwd(), input);
  const dir = absolute.endsWith('.json') ? dirname(absolute) : absolute;
  if (!existsSync(dir)) {
    throw new Error(`プロジェクトディレクトリが見つかりません: ${dir}`);
  }
  return dir;
}

// ─── 表示 ──────────────────────────────────────────────

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const STATUS_ICON: Record<ProgressEvent['status'], string> = {
  pending: '　',
  running: '⟳',
  completed: '✓',
  warning: '⚠',
  failed: '✗',
  skipped: '→',
  cancelled: '■',
};

function printHumanProgress(event: ProgressEvent): void {
  if (event.status === 'running' && event.stepRatio === undefined) {
    process.stdout.write(
      `${STATUS_ICON.running} [${event.stepIndex}/${event.stepCount}] ${event.stepLabel}...\n`,
    );
    return;
  }
  if (event.status === 'running') return; // 工程内進捗は通常モードでは省略する

  const icon = STATUS_ICON[event.status];
  const duration = formatDuration(event.elapsedMs);
  const extra = event.message ? ` — ${event.message}` : '';
  const warn = event.warning ? `\n    ⚠ ${event.warning}` : '';
  const err = event.error ? `\n    ✗ ${event.error.userMessage}` : '';

  process.stdout.write(
    `${icon} [${event.stepIndex}/${event.stepCount}] ${event.stepLabel} ${duration}${extra}${warn}${err}\n`,
  );
}

function printJsonProgress(event: ProgressEvent): void {
  process.stdout.write(`${JSON.stringify({ type: 'progress', ...event })}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const projectDir = resolveProjectDir(args.projectDir);
  const { project, notes } = loadProject(projectDir);

  if (!args.jsonProgress) {
    console.log(`プロジェクト: ${project.name}（${project.id}）`);
    for (const note of notes) console.log(`  ※ ${note}`);
    console.log('');
  }

  const controller = new AbortController();
  const onSigint = () => {
    if (!args.jsonProgress) {
      console.log('\n中止を要求しました。現在の工程が終わり次第、安全に停止します…');
    }
    controller.abort();
  };
  process.on('SIGINT', onSigint);

  const options: RunPipelineOptions = {
    fromStep: args.fromStep,
    toStep: args.toStep,
    onlySteps: args.onlySteps,
    force: args.force,
    signal: controller.signal,
    config: {
      syncMode: args.syncMode,
      transcribe: args.model ? { model: args.model } : undefined,
    },
    onProgress: args.jsonProgress ? printJsonProgress : printHumanProgress,
  };

  const result = await runPipeline(project, options);
  process.removeListener('SIGINT', onSigint);

  if (args.jsonProgress) {
    process.stdout.write(
      `${JSON.stringify({
        type: 'result',
        cancelled: result.cancelled,
        outcomes: result.outcomes,
        resolveDiff: result.resolveDiff,
      })}\n`,
    );
  } else {
    console.log('');
    console.log('─'.repeat(60));
    const failed = result.outcomes.filter((o) => o.status === 'failed');
    const warned = result.outcomes.filter((o) => o.status === 'warning');
    const skipped = result.outcomes.filter((o) => o.status === 'skipped');
    const completed = result.outcomes.filter((o) => o.status === 'completed');

    console.log(
      `完了 ${completed.length} / 警告 ${warned.length} / スキップ ${skipped.length} / 失敗 ${failed.length}` +
        (result.cancelled ? ' / ★中止されました' : ''),
    );

    for (const outcome of failed) {
      console.log(`  ✗ ${PIPELINE_STEP_LABELS[outcome.stepId]}: ${outcome.error?.userMessage}`);
      if (outcome.error?.suggestedAction) {
        console.log(`    → ${outcome.error.suggestedAction}`);
      }
    }

    if (result.resolveDiff) {
      const d = result.resolveDiff;
      if (d.orphaned.length > 0 || d.conflicted.length > 0 || d.reconnected.length > 0) {
        console.log('');
        console.log('人間の修正の再接続状況:');
        if (d.reconnected.length > 0) console.log(`  再接続: ${d.reconnected.length}件`);
        if (d.conflicted.length > 0) console.log(`  ⚠ 競合: ${d.conflicted.length}件（人間の修正を優先しています）`);
        if (d.orphaned.length > 0) {
          console.log(`  ⚠ 孤立: ${d.orphaned.length}件（内容は保持されています。確認画面で確認してください）`);
          for (const o of d.orphaned) console.log(`    - ${o.kind} ${o.originalId}: ${o.reason}`);
        }
      }
    }
    console.log('─'.repeat(60));
  }

  if (result.cancelled) process.exitCode = 130;
  else if (result.outcomes.some((o) => o.status === 'failed')) process.exitCode = 1;
  else process.exitCode = 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
