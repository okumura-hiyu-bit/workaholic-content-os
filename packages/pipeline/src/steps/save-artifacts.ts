/**
 * ⑭ 成果物の保存。
 *
 * 字幕SRT・話者名SRT・強調字幕SRT・YouTubeチャプター・ショート候補一覧・
 * 解析レポートを exports/ 配下に書き出す。
 *
 * ★ここも人間の修正を反映してから書く（resolveProject経由）。
 * XML本体は generate-premiere-xml が既に書いているため、ここでは触らない。
 */

import { join } from 'node:path';

import { resolveProject } from '../../../core/src/resolve.ts';
import { renderSrt, generateEmphasisSrt, generateYoutubeChapters } from '../../../editing/src/srt.ts';
import type { SrtCue } from '../../../editing/src/srt.ts';
import { writeManagedArtifact } from '../paths.ts';
import type { StepContext, StepDefinition, StepResult } from '../types.ts';

function subtitleCuesToSrt(cues: { startSec: number; endSec: number; lines: string[] }[]): string {
  const srtCues: SrtCue[] = cues.map((c, i) => ({
    index: i + 1,
    startSec: c.startSec,
    endSec: c.endSec,
    lines: c.lines,
  }));
  return renderSrt(srtCues);
}

function speakerLowerThirdSrt(
  speech: readonly { startSec: number; endSec: number; speakerId: string }[],
  speakers: readonly { id: string; name: string; title?: string }[],
): string {
  const byId = new Map(speakers.map((s) => [s.id, s]));
  const sorted = [...speech].sort((a, b) => a.startSec - b.startSec);
  const cues: SrtCue[] = [];
  let current: { speakerId: string; startSec: number; endSec: number } | undefined;

  const flush = () => {
    if (!current) return;
    const speaker = byId.get(current.speakerId);
    if (!speaker) return;
    cues.push({
      index: cues.length + 1,
      startSec: current.startSec,
      endSec: current.endSec,
      lines: speaker.title ? [speaker.name, speaker.title] : [speaker.name],
    });
  };

  for (const seg of sorted) {
    if (current && current.speakerId === seg.speakerId) {
      current.endSec = Math.max(current.endSec, seg.endSec);
      continue;
    }
    flush();
    current = { speakerId: seg.speakerId, startSec: seg.startSec, endSec: seg.endSec };
  }
  flush();
  return renderSrt(cues);
}

function shortsCsv(
  shorts: readonly {
    id: string;
    startSec: number;
    endSec: number;
    score: number;
    adopted?: boolean;
    title?: string;
    signals: readonly string[];
  }[],
): string {
  const header = 'id,startSec,endSec,score,adopted,title,signals';
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = shorts.map((s) =>
    [
      s.id,
      s.startSec.toFixed(2),
      s.endSec.toFixed(2),
      s.score,
      s.adopted === undefined ? '未判断' : s.adopted ? '採用' : '不採用',
      esc(s.title ?? ''),
      esc(s.signals.join(' / ')),
    ].join(','),
  );
  return [header, ...rows].join('\n') + '\n';
}

function reportHtml(ctx: StepContext, warnings: readonly string[]): string {
  const a = ctx.analysis;
  const rows = [
    ['字幕キュー数', a.subtitles.length],
    ['チャプター数', a.chapters.length],
    ['カメラ切替カット数', a.cameraShots.length],
    ['マーカー数', a.markers.length],
    ['ショート候補数', a.shortCandidates.length],
    ['要確認事項', a.checks.length],
  ]
    .map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`)
    .join('\n');

  const warningItems = warnings.map((w) => `<li>${w}</li>`).join('\n');

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>解析レポート — ${ctx.project.name}</title>
<style>
  body{font-family:-apple-system,"Noto Sans JP",sans-serif;background:#fff;color:#1F2933;max-width:640px;margin:40px auto;padding:0 16px}
  table{border-collapse:collapse;width:100%}
  td{border-bottom:1px solid #E3E8EF;padding:8px}
  h1{font-size:20px} h2{font-size:16px;color:#6B7280}
</style></head>
<body>
  <h1>${ctx.project.name} — 解析レポート</h1>
  <p>生成日時: ${ctx.now().toISOString()}</p>
  <table>${rows}</table>
  <h2>要確認（${warnings.length}件）</h2>
  <ul>${warningItems || '<li>なし</li>'}</ul>
</body></html>
`;
}

export const saveArtifactsStep: StepDefinition = {
  id: 'save-artifacts',
  deps: ['generate-premiere-xml', 'generate-subtitles', 'generate-chapters', 'extract-short-candidates'],
  async run(ctx: StepContext): Promise<StepResult> {
    const { resolved } = resolveProject(ctx.analysis, ctx.project.edits);
    const outputFiles: string[] = [];

    const write = (absolutePath: string, data: string) => {
      outputFiles.push(writeManagedArtifact(ctx.project, ctx.paths, absolutePath, data));
    };

    write(
      join(ctx.paths.exports.subtitles, 'subtitle.srt'),
      subtitleCuesToSrt(resolved.subtitles),
    );
    write(
      join(ctx.paths.exports.subtitles, 'speaker.srt'),
      speakerLowerThirdSrt(ctx.analysis.speech, ctx.project.speakers),
    );
    write(
      join(ctx.paths.exports.subtitles, 'emphasis.srt'),
      generateEmphasisSrt(ctx.analysis.emphasis),
    );
    write(
      join(ctx.paths.exports.chapters, 'youtube-chapters.txt'),
      generateYoutubeChapters(resolved.chapters.map((c) => ({ startSec: c.startSec, title: c.title }))),
    );
    write(join(ctx.paths.exports.shorts, 'shorts.csv'), shortsCsv(resolved.shorts));

    const allWarnings = ctx.analysis.checks.map((c) => c.message);
    write(join(ctx.paths.exports.reports, 'report.html'), reportHtml(ctx, allWarnings));

    ctx.log({ event: 'finish', success: true });

    return {
      status: 'completed',
      outputFiles,
      message: `成果物${outputFiles.length}件を書き出しました`,
    };
  },
};
