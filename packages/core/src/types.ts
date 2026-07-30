/**
 * データ構造の型定義。
 * スプレッドシートの各シートが、そのまま以下の型に対応する。
 *
 * @see docs/05-data-structure.md
 */

import type { PostStatus } from './status.ts';

/** 対応媒体。新媒体を追加する際はここと packages/platforms/ に足す。 */
export const PLATFORMS = [
  'youtube',
  'youtube_shorts',
  'instagram_reels',
  'tiktok',
  'podcast',
  'x',
] as const;

export type Platform = (typeof PLATFORMS)[number];

/** 手動投稿（Cランク）で運用する媒体。MVPではIG/TikTokがここに入る。 */
export const MANUAL_POST_PLATFORMS: readonly Platform[] = [
  'instagram_reels',
  'tiktok',
  'x',
];

export type DeliverableType =
  | 'long_video'
  | 'short_video'
  | 'audio'
  | 'thumbnail'
  | 'image';

/** 収録（親）。Content Repurposing の原資産。 */
export interface Episode {
  episodeId: string;
  /** 将来のクライアント展開用。現在は 'wh_main' 固定。 */
  channelId: string;
  title: string;
  theme: string;
  guest: string;
  recordedAt: string;
  targetPublish: string;
  status: '素材準備中' | '進行中' | '公開済み' | 'アーカイブ';
  transcriptUrl?: string;
  briefSummary?: string;
  note?: string;
}

/** 成果物（素材の実体）。1収録から複数生まれる。 */
export interface Deliverable {
  deliverableId: string;
  episodeId: string;
  type: DeliverableType;
  filename: string;
  /** この素材の「切り口」。分析の最重要キー。 */
  angle?: string;
  sourceTimecode?: string;
  durationSec?: number;
  mediaUrl?: string;
  /** RSSのenclosure lengthに使う実バイト数。 */
  fileSize?: number;
  status: '素材準備中' | '準備完了';
}

/** 投稿（媒体 × 成果物）。承認の対象。 */
export interface Post {
  postId: string;
  episodeId: string;
  deliverableId?: string;
  platform: Platform;
  title: string;
  titleOptions: string[];
  body: string;
  hashtags: string[];
  thumbnailText?: string;
  scheduledAt?: string;
  status: PostStatus;
  approvedBy?: string;
  approvedAt?: string;
  postUrl?: string;
  postedAt?: string;
  error?: string;
  /** AI生成の原文。修正率の計測とプロンプト改善に使う。 */
  aiOriginal?: string;
}

export interface Chapter {
  startTime: number;
  title: string;
}

export interface PodcastPerson {
  role: 'host' | 'guest';
  name: string;
  description?: string;
}

/** RSS配信用のメタ情報。posts の podcast 行だけでは表現できない項目を持つ。 */
export interface PodcastEpisode {
  episodeId: string;
  /** ★一度発行したら絶対に変更しない。変更すると配信アプリで重複表示される。 */
  guid: string;
  episodeNumber: number;
  season?: number;
  itunesSummary: string;
  contentHtml: string;
  chapters: Chapter[];
  persons: PodcastPerson[];
  keywords: string[];
  episodeImageUrl?: string;
  durationSec: number;
  fileSize: number;
  explicit: boolean;
}

/** 番組全体の設定。管理画面のポッドキャスト画面で編集する。 */
export interface PodcastShow {
  title: string;
  link: string;
  description: string;
  language: string;
  author: string;
  ownerName: string;
  /** ★各サービスの所有権確認に使われる。受信可能なアドレスであること。 */
  ownerEmail: string;
  coverImageUrl: string;
  category: string;
  subCategory?: string;
  explicit: boolean;
  type: 'episodic' | 'serial';
  copyright?: string;
}

export interface KpiRow {
  date: string;
  channelId: string;
  platform: Platform;
  scope: 'channel' | 'post';
  refId: string;
  /** 取得できなかった指標は undefined のまま。0を入れてはならない。 */
  followers?: number;
  views?: number;
  downloads?: number;
  impressions?: number;
  reach?: number;
  ctr?: number;
  avgViewPct?: number;
  comments?: number;
  saves?: number;
  shares?: number;
  inquiries?: number;
  /** 自動取得値と手入力値を区別するために必須。 */
  source: 'api' | 'op3' | 'manual_csv' | 'manual';
}
