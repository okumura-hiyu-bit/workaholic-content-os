import { describe, expect, it } from 'vitest';

import type {
  Deliverable,
  PodcastEpisode,
  PodcastShow,
  Post,
} from '@contentos/core/types';
import type { PostStatus } from '@contentos/core/status';
import {
  applyOp3Prefix,
  escapeXml,
  generateChaptersJson,
  generateFeed,
  selectFeedItems,
  toDuration,
  toRfc822,
  wrapCdata,
} from './rss.ts';

const NOW = new Date('2026-07-25T00:00:00Z');

const SHOW: PodcastShow = {
  title: 'WORKAHOLIC RADIO',
  link: 'https://workaholic.co.jp/podcast',
  description: '企業の情報発信を仕組み化する',
  language: 'ja',
  author: 'WORKAHOLIC株式会社',
  ownerName: 'WORKAHOLIC株式会社',
  ownerEmail: 'podcast@example.com',
  coverImageUrl: 'https://example.com/cover.jpg',
  category: 'Business',
  subCategory: 'Entrepreneurship',
  explicit: false,
  type: 'episodic',
};

function makeEpisode(overrides: Partial<PodcastEpisode> = {}): PodcastEpisode {
  return {
    episodeId: 'ep012',
    guid: 'workaholic-ep012',
    episodeNumber: 12,
    itunesSummary: '採用ブランディングの話',
    contentHtml: '<p>採用ブランディングの話</p>',
    chapters: [
      { startTime: 0, title: 'オープニング' },
      { startTime: 135, title: '給与では勝てない理由' },
    ],
    persons: [
      { role: 'host', name: '岸本' },
      { role: 'guest', name: '山田太郎', description: '人事部長' },
    ],
    keywords: ['採用', 'ブランディング'],
    durationSec: 1832,
    fileSize: 28_311_552,
    explicit: false,
    ...overrides,
  };
}

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    postId: 'p-pod-012',
    episodeId: 'ep012',
    platform: 'podcast',
    title: '第12回 採用ブランディング',
    titleOptions: [],
    body: '',
    hashtags: [],
    scheduledAt: '2026-07-22T09:00:00Z',
    status: '承認済み',
    ...overrides,
  };
}

function makeAudio(overrides: Partial<Deliverable> = {}): Deliverable {
  return {
    deliverableId: 'ep012_audio',
    episodeId: 'ep012',
    type: 'audio',
    filename: 'audio/ep012.mp3',
    mediaUrl: 'https://github.com/wh/media/releases/download/ep012/ep012.mp3',
    fileSize: 28_311_552,
    durationSec: 1832,
    status: '準備完了',
    ...overrides,
  };
}

function buildInput(posts: Post[], now = NOW) {
  return {
    show: SHOW,
    posts,
    podcastEpisodes: new Map([['ep012', makeEpisode()]]),
    audioDeliverables: new Map([['ep012', makeAudio()]]),
    chaptersBaseUrl: 'https://podcast.example.com',
    now,
  };
}

describe('selectFeedItems — 誤配信の防止', () => {
  it('承認済みかつ公開時刻到来のものを出力する', () => {
    expect(selectFeedItems(buildInput([makePost()]))).toHaveLength(1);
  });

  it('公開済みも引き続き出力する（フィードから消えてはならない）', () => {
    const items = selectFeedItems(buildInput([makePost({ status: '公開済み' })]));
    expect(items).toHaveLength(1);
  });

  const blocked: PostStatus[] = [
    '素材準備中',
    'AI生成待ち',
    '編集中',
    '確認待ち',
    '修正中',
    '予約投稿済み',
    '投稿失敗',
  ];

  it.each(blocked)('「%s」はフィードに出力されない', (status) => {
    expect(selectFeedItems(buildInput([makePost({ status })]))).toHaveLength(0);
  });

  it('公開時刻が未来のものは出力されない（これが予約公開の実装）', () => {
    const items = selectFeedItems(
      buildInput([makePost({ scheduledAt: '2026-07-26T09:00:00Z' })]),
    );
    expect(items).toHaveLength(0);
  });

  it('公開時刻が到来した瞬間から出力される', () => {
    const post = makePost({ scheduledAt: '2026-07-26T09:00:00Z' });
    expect(selectFeedItems(buildInput([post], NOW))).toHaveLength(0);
    const later = new Date('2026-07-26T09:00:01Z');
    expect(selectFeedItems(buildInput([post], later))).toHaveLength(1);
  });

  it('podcast以外の媒体は無視する', () => {
    const items = selectFeedItems(buildInput([makePost({ platform: 'youtube' })]));
    expect(items).toHaveLength(0);
  });

  it('音声のバイト数が欠けているものは配信しない', () => {
    const input = {
      ...buildInput([makePost()]),
      audioDeliverables: new Map([['ep012', makeAudio({ fileSize: undefined })]]),
    };
    expect(selectFeedItems(input)).toHaveLength(0);
  });

  it('音声が未アップロードなら配信しない', () => {
    const input = {
      ...buildInput([makePost()]),
      audioDeliverables: new Map([['ep012', makeAudio({ mediaUrl: undefined })]]),
    };
    expect(selectFeedItems(input)).toHaveLength(0);
  });
});

describe('generateFeed', () => {
  it('必須のチャンネル要素を含む', () => {
    const xml = generateFeed(buildInput([makePost()]));
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<title>WORKAHOLIC RADIO</title>');
    expect(xml).toContain('<itunes:email>podcast@example.com</itunes:email>');
    expect(xml).toContain('<itunes:image href="https://example.com/cover.jpg"/>');
    expect(xml).toContain(
      '<itunes:category text="Business"><itunes:category text="Entrepreneurship"/></itunes:category>',
    );
  });

  it('enclosureにOP3プレフィックスと正しいバイト数を出力する', () => {
    const xml = generateFeed(buildInput([makePost()]));
    expect(xml).toContain(
      'url="https://op3.dev/e/github.com/wh/media/releases/download/ep012/ep012.mp3"',
    );
    expect(xml).toContain('length="28311552"');
    expect(xml).toContain('type="audio/mpeg"');
  });

  it('guidをisPermaLink=falseで出力する', () => {
    const xml = generateFeed(buildInput([makePost()]));
    expect(xml).toContain('<guid isPermaLink="false">workaholic-ep012</guid>');
  });

  it('チャプターとpersonを出力する', () => {
    const xml = generateFeed(buildInput([makePost()]));
    expect(xml).toContain(
      'url="https://podcast.example.com/ep012/chapters.json"',
    );
    expect(xml).toContain('<podcast:person role="guest"');
    expect(xml).toContain('山田太郎');
  });

  it('itunes:durationをHH:MM:SSで出力する', () => {
    const xml = generateFeed(buildInput([makePost()]));
    expect(xml).toContain('<itunes:duration>00:30:32</itunes:duration>');
  });

  it('承認前のエピソードは1バイトも出力しない', () => {
    const xml = generateFeed(buildInput([makePost({ status: '確認待ち' })]));
    expect(xml).not.toContain('workaholic-ep012');
    expect(xml).not.toContain('<item>');
    // フィード自体は妥当なXMLとして成立する必要がある。
    expect(xml).toContain('</channel>');
  });

  it('新しい順に並べる', () => {
    const input = {
      ...buildInput([
        makePost({ postId: 'a', scheduledAt: '2026-07-15T09:00:00Z' }),
        makePost({ postId: 'b', scheduledAt: '2026-07-22T09:00:00Z' }),
      ]),
    };
    const items = selectFeedItems(input);
    expect(items.map((i) => i.post.postId)).toEqual(['b', 'a']);
  });
});

describe('XMLの安全性', () => {
  it('特殊文字をエスケープする', () => {
    expect(escapeXml('a & b < c > d "e" \'f\'')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;',
    );
  });

  it('タイトルに & が含まれてもフィードが壊れない', () => {
    const xml = generateFeed(
      buildInput([makePost({ title: '採用 & 広報の話 <重要>' })]),
    );
    expect(xml).toContain('採用 &amp; 広報の話 &lt;重要&gt;');
    expect(xml).not.toContain('<重要>');
  });

  it('CDATA内の ]]> を分割してフィードを壊さない', () => {
    expect(wrapCdata('a]]>b')).toBe('<![CDATA[a]]]]><![CDATA[>b]]>');
  });
});

describe('フォーマット変換', () => {
  it('pubDateをRFC 822で出力する', () => {
    expect(toRfc822(new Date('2026-07-22T09:00:00Z'))).toBe(
      'Wed, 22 Jul 2026 09:00:00 +0000',
    );
  });

  it('秒数をHH:MM:SSに変換する', () => {
    expect(toDuration(0)).toBe('00:00:00');
    expect(toDuration(59)).toBe('00:00:59');
    expect(toDuration(1832)).toBe('00:30:32');
    expect(toDuration(3661)).toBe('01:01:01');
  });

  it('OP3プレフィックスを二重に付けない', () => {
    const once = applyOp3Prefix('https://example.com/a.mp3', true);
    expect(applyOp3Prefix(once, true)).toBe(once);
  });

  it('OP3を無効にできる', () => {
    expect(applyOp3Prefix('https://example.com/a.mp3', false)).toBe(
      'https://example.com/a.mp3',
    );
  });
});

describe('generateChaptersJson', () => {
  it('Podcasting 2.0形式で出力する', () => {
    const parsed = JSON.parse(generateChaptersJson(makeEpisode()));
    expect(parsed.version).toBe('1.2.0');
    expect(parsed.chapters).toEqual([
      { startTime: 0, title: 'オープニング' },
      { startTime: 135, title: '給与では勝てない理由' },
    ]);
  });
});
