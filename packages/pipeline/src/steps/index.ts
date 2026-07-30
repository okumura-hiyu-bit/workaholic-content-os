/**
 * 全15工程の実装をIDで引けるようにする。
 *
 * ★テスト用にオーバーライドできる（run-pipeline.ts の `steps` オプション）。
 * 実素材・実ffmpeg・実whisperを使わない高速なフェイク実装に差し替えて、
 * オーケストレーション（進捗・キャンセル・キャッシュ・依存関係）だけを
 * 検証できるようにするため。
 */

import type { PipelineStepId, StepDefinition } from '../types.ts';
import { validateProjectStep } from './validate-project.ts';
import { probeMediaStep } from './probe-media.ts';
import { extractAudioStep } from './extract-audio.ts';
import { syncMediaStep } from './sync-media.ts';
import { correctAudioStep } from './correct-audio.ts';
import { transcribeStep } from './transcribe.ts';
import { detectSpeakersStep } from './detect-speakers.ts';
import { generateSubtitlesStep } from './generate-subtitles.ts';
import { generateChaptersStep } from './generate-chapters.ts';
import { generateCameraPlanStep } from './generate-camera-plan.ts';
import { generateMarkersStep } from './generate-markers.ts';
import { extractShortCandidatesStep } from './extract-short-candidates.ts';
import { generatePremiereXmlStep } from './generate-premiere-xml.ts';
import { saveArtifactsStep } from './save-artifacts.ts';
import { saveProjectStep } from './save-project.ts';

export const DEFAULT_STEP_DEFINITIONS: Record<PipelineStepId, StepDefinition> = {
  'validate-project': validateProjectStep,
  'probe-media': probeMediaStep,
  'extract-audio': extractAudioStep,
  'sync-media': syncMediaStep,
  'correct-audio': correctAudioStep,
  transcribe: transcribeStep,
  'detect-speakers': detectSpeakersStep,
  'generate-subtitles': generateSubtitlesStep,
  'generate-chapters': generateChaptersStep,
  'generate-camera-plan': generateCameraPlanStep,
  'generate-markers': generateMarkersStep,
  'extract-short-candidates': extractShortCandidatesStep,
  'generate-premiere-xml': generatePremiereXmlStep,
  'save-artifacts': saveArtifactsStep,
  'save-project': saveProjectStep,
};

export * from './extract-audio.ts';
export * from './correct-audio.ts';
