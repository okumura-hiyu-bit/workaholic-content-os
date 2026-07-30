/**
 * 素材解析と編集提案の型定義。
 *
 * 出演者数の上限をコードに持たせない。cam_C / mic_C を置けば3人目として
 * 扱われる構造にしてある。
 *
 * @see docs/11-editing-pipeline.md
 */

export interface Speaker {
  /** 'A' | 'B' | 'C' … 素材の命名規約に対応する。 */
  id: string;
  name: string;
  title?: string;
  role: 'host' | 'guest';
}

export type CameraKind = 'wide' | 'closeup';

export interface CameraSource {
  /** 'wide' | 'cam_A' | 'cam_B' … */
  id: string;
  kind: CameraKind;
  /** closeup の場合、誰を写しているか。 */
  speakerId?: string;
  file: string;
  /** 引き映像を基準としたオフセット秒。同期解析が算出する。 */
  syncOffsetSec: number;
}

export interface SpeechSegment {
  startSec: number;
  endSec: number;
  speakerId: string;
  text: string;
}

/** 笑いの区間。削るためではなく活かすための情報。 */
export interface LaughterSegment {
  startSec: number;
  endSec: number;
  /** 誰が笑ったか（判定できた場合）。 */
  speakerIds?: string[];
  /**
   * 判定の確信度（0〜1）。音量変動だけでは笑いを確実に判別できないため、
   * 低い値は編集者の確認前提としてマーカーのコメントに明記する。
   */
  confidence?: number;
}

/** 単語単位のタイムコード。字幕生成の入力。 */
export interface Word {
  startSec: number;
  endSec: number;
  text: string;
  speakerId?: string;
}

/** AIが抽出した強調ポイント。強調テロップとショートのフックになる。 */
export interface EmphasisPoint {
  startSec: number;
  endSec: number;
  /** テロップに出す短い文言。 */
  text: string;
  /** 元の発言。 */
  quote: string;
  speakerId?: string;
}

export interface TopicSegment {
  startSec: number;
  endSec: number;
  title: string;
}

export type ShotReason =
  | 'speech'
  | 'overlap'
  | 'laughter'
  | 'hold'
  | 'reaction'
  | 'merged';

/** カメラ切替案の1ショット。編集者が自由に変更できる前提の「提案」。 */
export interface CameraShot {
  startSec: number;
  endSec: number;
  cameraId: string;
  /** なぜこのカメラを選んだか。編集者が判断できるように必ず持たせる。 */
  reason: ShotReason;
}

export interface CameraRules {
  /** 最短ショット長。これより短いショットは前後に統合する。 */
  minShotSec: number;
  /** 発話開始の何秒前に切り替えるか（頭の音を欠けさせない）。 */
  leadInSec: number;
  /** 同一カメラがこの秒数を超えたらリアクションカットを挿入する。 */
  maxSameCameraSec: number;
  /** リアクションカットの長さ。 */
  reactionShotSec: number;
  /** 笑いのときに引きへ切り替えるか。 */
  wideOnLaughter: boolean;
  /**
   * 笑いを根拠にカメラを切り替えるための最低確信度。
   *
   * ★笑い検出は補助判定に留める。確信度がこれを下回る候補は
   * カメラ切替の根拠にせず、マーカー（要確認）としてのみ提示する。
   * confidence が未設定の候補（文字起こし由来など）は信頼できるものとして扱う。
   */
  minLaughterConfidence: number;
  /** 複数話者の同時発話で引きへ切り替えるか。 */
  wideOnOverlap: boolean;
}

export const DEFAULT_CAMERA_RULES: CameraRules = {
  minShotSec: 2.5,
  leadInSec: 0.3,
  maxSameCameraSec: 20,
  reactionShotSec: 2,
  wideOnLaughter: true,
  minLaughterConfidence: 0.5,
  wideOnOverlap: true,
};

/** マーカーの種類。色はXMLで指定できないため接頭辞で表現する。 */
export type MarkerKind =
  | 'TOPIC'
  | 'LAUGH'
  | 'KEY'
  | 'SHORT'
  | 'RETAKE'
  | 'CHECK'
  | 'SPONSOR'
  | 'OP'
  | 'ED';

export interface TimelineMarker {
  startSec: number;
  endSec?: number;
  kind: MarkerKind;
  name: string;
  /** 選定理由・引用など。編集者が判断するための情報を必ず入れる。 */
  comment: string;
}

/** ショート候補。編集者が採否を決める。 */
export interface ShortCandidate {
  id: string;
  startSec: number;
  endSec: number;
  title: string;
  /** 冒頭2秒で言うべき一文。 */
  hook: string;
  /** なぜこの区間を選んだか。 */
  rationale: string;
  /** 主に話している人。縦型構図の基準になる。 */
  primarySpeakerId?: string;
}
