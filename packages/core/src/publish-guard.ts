/**
 * 投稿可否の判定。docs/04-approval-flow.md 4.2 の安全装置を実装する。
 *
 * 純粋関数として切り出しているのは、投稿の可否判定をテストで固定するため。
 * 管理画面・CLI・GitHub Actions のどこから投稿しても、必ずこの関数を通る。
 */

import { isPublishable } from './status.ts';
import type { Deliverable, Post } from './types.ts';

/** 障害復旧時に古い投稿が一斉に飛ぶのを防ぐための猶予時間。 */
export const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000;

export type PublishDecision =
  | { publish: true }
  | { publish: false; reason: string };

export interface PublishGuardInput {
  post: Post;
  /** メディアを伴う媒体では必須。告知投稿など不要な媒体では undefined。 */
  deliverable?: Deliverable;
  now: Date;
}

/**
 * この投稿を今このタイミングで実行してよいかを判定する。
 *
 * 判定順は「安全側の条件を先に」並べている。理由文はそのまま error 列に
 * 記録され、管理画面のダッシュボードに表示される。
 */
export function shouldPublish({
  post,
  deliverable,
  now,
}: PublishGuardInput): PublishDecision {
  // 装置1: ホワイトリスト方式。承認済み以外は投稿処理から見て存在しない。
  if (!isPublishable(post.status)) {
    return {
      publish: false,
      reason: `ステータスが「${post.status}」のため対象外です（承認済みのみ投稿されます）`,
    };
  }

  // 重複投稿の防止。すでにURLがあるものは何があっても投稿しない。
  if (post.postUrl) {
    return {
      publish: false,
      reason: '公開URLが既に記録されています（重複投稿の防止）',
    };
  }

  // 装置3: 必須項目の検証。空文字での投稿事故を防ぐ。
  if (!post.title.trim() && !post.body.trim()) {
    return { publish: false, reason: 'タイトルと本文がどちらも空です' };
  }
  if (!post.scheduledAt) {
    return { publish: false, reason: '投稿予定日時が設定されていません' };
  }

  const scheduled = new Date(post.scheduledAt);
  if (Number.isNaN(scheduled.getTime())) {
    return {
      publish: false,
      reason: `投稿予定日時を解釈できません: ${post.scheduledAt}`,
    };
  }

  // 装置4: 時刻ガード（未来）。
  if (scheduled.getTime() > now.getTime()) {
    return { publish: false, reason: '投稿予定時刻がまだ到来していません' };
  }

  // 装置4: 時刻ガード（古すぎる）。
  const elapsed = now.getTime() - scheduled.getTime();
  if (elapsed > STALE_THRESHOLD_MS) {
    const hours = Math.floor(elapsed / 3_600_000);
    return {
      publish: false,
      reason: `投稿予定時刻が${hours}時間前で古すぎます（48時間超のため自動投稿を中止しました。日時を見直して再承認してください）`,
    };
  }

  // メディアを伴う媒体では、実体が用意できているかを確認する。
  if (deliverable && !deliverable.mediaUrl) {
    return {
      publish: false,
      reason: 'メディアがアップロードされていません（stage を実行してください）',
    };
  }

  return { publish: true };
}

/**
 * 投稿処理が拾う対象を絞り込む。
 *
 * ★この関数以外から posts を投稿対象として取り出してはならない。
 */
export function selectPublishable(
  posts: readonly Post[],
  deliverables: ReadonlyMap<string, Deliverable>,
  now: Date,
): { post: Post; decision: PublishDecision }[] {
  return posts.map((post) => ({
    post,
    decision: shouldPublish({
      post,
      deliverable: post.deliverableId
        ? deliverables.get(post.deliverableId)
        : undefined,
      now,
    }),
  }));
}
