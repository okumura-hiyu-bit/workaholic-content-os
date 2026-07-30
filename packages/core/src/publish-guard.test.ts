import { describe, expect, it } from 'vitest';

import { shouldPublish, STALE_THRESHOLD_MS } from './publish-guard.ts';
import { POST_STATUSES, canTransition, canRepost, canUnapprove } from './status.ts';
import type { Deliverable, Post } from './types.ts';

const NOW = new Date('2026-07-22T09:00:00Z');

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    postId: 'p1',
    episodeId: 'ep012',
    deliverableId: 'ep012_main',
    platform: 'youtube',
    title: '中小企業が採用で勝つ「働く理由の可視化」',
    titleOptions: [],
    body: '概要欄の本文',
    hashtags: [],
    scheduledAt: '2026-07-22T08:00:00Z',
    status: '承認済み',
    ...overrides,
  };
}

function makeDeliverable(overrides: Partial<Deliverable> = {}): Deliverable {
  return {
    deliverableId: 'ep012_main',
    episodeId: 'ep012',
    type: 'long_video',
    filename: 'main.mp4',
    mediaUrl: 'https://example.com/main.mp4',
    fileSize: 1024,
    status: '準備完了',
    ...overrides,
  };
}

describe('shouldPublish — 承認制の担保', () => {
  it('承認済みかつ時刻到来なら投稿する', () => {
    const result = shouldPublish({
      post: makePost(),
      deliverable: makeDeliverable(),
      now: NOW,
    });
    expect(result.publish).toBe(true);
  });

  // 最重要のテスト。承認済み以外のすべての状態で投稿されないことを網羅的に確認する。
  it.each(POST_STATUSES.filter((s) => s !== '承認済み'))(
    '「%s」は投稿されない',
    (status) => {
      const result = shouldPublish({
        post: makePost({ status }),
        deliverable: makeDeliverable(),
        now: NOW,
      });
      expect(result.publish).toBe(false);
    },
  );

  it('公開URLが既にある場合は投稿しない（重複投稿の防止）', () => {
    const result = shouldPublish({
      post: makePost({ postUrl: 'https://youtu.be/abc' }),
      deliverable: makeDeliverable(),
      now: NOW,
    });
    expect(result.publish).toBe(false);
  });

  it('タイトルと本文が両方空なら投稿しない', () => {
    const result = shouldPublish({
      post: makePost({ title: '   ', body: '' }),
      deliverable: makeDeliverable(),
      now: NOW,
    });
    expect(result.publish).toBe(false);
  });

  it('投稿予定日時が未設定なら投稿しない', () => {
    const result = shouldPublish({
      post: makePost({ scheduledAt: undefined }),
      deliverable: makeDeliverable(),
      now: NOW,
    });
    expect(result.publish).toBe(false);
  });

  it('解釈できない日時なら投稿しない', () => {
    const result = shouldPublish({
      post: makePost({ scheduledAt: '7月22日ごろ' }),
      deliverable: makeDeliverable(),
      now: NOW,
    });
    expect(result.publish).toBe(false);
  });
});

describe('shouldPublish — 時刻ガード', () => {
  it('予定時刻が未来なら投稿しない', () => {
    const result = shouldPublish({
      post: makePost({ scheduledAt: '2026-07-22T18:00:00Z' }),
      deliverable: makeDeliverable(),
      now: NOW,
    });
    expect(result.publish).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('到来') });
  });

  it('48時間を超えて古い予定は投稿しない（障害復旧時の一斉投稿を防ぐ）', () => {
    const stale = new Date(NOW.getTime() - STALE_THRESHOLD_MS - 60_000);
    const result = shouldPublish({
      post: makePost({ scheduledAt: stale.toISOString() }),
      deliverable: makeDeliverable(),
      now: NOW,
    });
    expect(result.publish).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('古すぎ') });
  });

  it('48時間ちょうど以内なら投稿する', () => {
    const edge = new Date(NOW.getTime() - STALE_THRESHOLD_MS + 60_000);
    const result = shouldPublish({
      post: makePost({ scheduledAt: edge.toISOString() }),
      deliverable: makeDeliverable(),
      now: NOW,
    });
    expect(result.publish).toBe(true);
  });
});

describe('shouldPublish — メディアの検証', () => {
  it('メディアが未アップロードなら投稿しない', () => {
    const result = shouldPublish({
      post: makePost(),
      deliverable: makeDeliverable({ mediaUrl: undefined }),
      now: NOW,
    });
    expect(result.publish).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('stage') });
  });

  it('メディアを伴わない媒体（告知投稿）は成果物なしでも投稿する', () => {
    const result = shouldPublish({
      post: makePost({ platform: 'x', deliverableId: undefined }),
      deliverable: undefined,
      now: NOW,
    });
    expect(result.publish).toBe(true);
  });
});

describe('ステータス遷移', () => {
  it('確認待ちから承認済みに進める', () => {
    expect(canTransition('確認待ち', '承認済み').ok).toBe(true);
  });

  it('承認済みから確認待ちに戻せる（承認取消）', () => {
    expect(canTransition('承認済み', '確認待ち').ok).toBe(true);
  });

  it('公開済みからは一切遷移できない', () => {
    for (const to of POST_STATUSES) {
      if (to === '公開済み') continue;
      expect(canTransition('公開済み', to).ok).toBe(false);
    }
  });

  it('素材準備中から承認済みへ飛び越えられない', () => {
    expect(canTransition('素材準備中', '承認済み').ok).toBe(false);
  });

  it('ingest後の編集中から確認待ちへ進める（書き出し検知）', () => {
    expect(canTransition('編集中', '確認待ち').ok).toBe(true);
  });

  it('編集中から承認済みへ飛び越えられない（確認を必ず通す）', () => {
    expect(canTransition('編集中', '承認済み').ok).toBe(false);
  });

  it('確認待ちから編集中へ差し戻せる', () => {
    expect(canTransition('確認待ち', '編集中').ok).toBe(true);
  });

  it('同一ステータスへの変更は許可する（冪等な保存のため）', () => {
    expect(canTransition('確認待ち', '確認待ち').ok).toBe(true);
  });
});

describe('承認取消・再投稿の制限', () => {
  it('公開済みは承認取消できない', () => {
    expect(canUnapprove('公開済み').ok).toBe(false);
  });

  it('承認済みは承認取消できる', () => {
    expect(canUnapprove('承認済み').ok).toBe(true);
  });

  it('公開URLがあるものは再投稿できない', () => {
    expect(canRepost('投稿失敗', 'https://youtu.be/abc').ok).toBe(false);
  });

  it('投稿失敗でURLがなければ再投稿できる', () => {
    expect(canRepost('投稿失敗', undefined).ok).toBe(true);
  });
});
