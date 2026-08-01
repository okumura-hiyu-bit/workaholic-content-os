/**
 * ポッドキャストRSSフィードの生成。
 *
 * 生成のたびに「承認済み かつ 公開時刻到来」のエピソードだけを出力する。
 * 承認前のエピソードはフィードに1バイトも書き出されないため、
 * 誤配信が構造的に起こり得ない。予約公開に cron を必要としないのも同じ理由。
 *
 * @see docs/09-podcast.md 9.3 / 9.4
 */

import type {
  Deliverable,
  PodcastEpisode,
  PodcastShow,
  Post,
} from '@contentos/core/types';
import { isPublishable } from '@contentos/core/status';

/** OP3プレフィックス。無料のダウンロード計測（IAB 2.0準拠）。 */
const OP3_PREFIX = 'https://op3.dev/e/';

export interface FeedInput {
  show: PodcastShow;
  /** platform === 'podcast' の投稿行。 */
  posts: readonly Post[];
  podcastEpisodes: ReadonlyMap<string, PodcastEpisode>;
  /** episodeId -> 音声成果物。 */
  audioDeliverables: ReadonlyMap<string, Deliverable>;
  /** チャプターJSONを配信するベースURL。 */
  chaptersBaseUrl: string;
  now: Date;
  /** OP3による計測を無効化したい場合のみ false。既定は有効。 */
  enableOp3?: boolean;
}

/** XMLのテキストノード・属性値として安全な文字列に変換する。 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** CDATA内で `]]>` が現れてもフィードが壊れないように分割する。 */
export function wrapCdata(value: string): string {
  return `<![CDATA[${value.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

/** RFC 822 形式（RSSのpubDateに必要な形式）に変換する。 */
export function toRfc822(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const pad = (n: number) => String(n).padStart(2, '0');

  // 配信先が解釈を誤らないよう、常にUTC（+0000）で出力する。
  return (
    `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ` +
    `${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} +0000`
  );
}

/** 秒数を itunes:duration の HH:MM:SS 形式にする。 */
export function toDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** OP3プレフィックスを付与する。プロトコル部分を除いたURLを後ろに繋ぐ。 */
export function applyOp3Prefix(mediaUrl: string, enabled: boolean): string {
  if (!enabled) return mediaUrl;
  if (mediaUrl.startsWith(OP3_PREFIX)) return mediaUrl;
  return OP3_PREFIX + mediaUrl.replace(/^https?:\/\//, '');
}

interface PublishableItem {
  post: Post;
  episode: PodcastEpisode;
  audio: Deliverable;
  pubDate: Date;
}

/**
 * フィードに含めてよいエピソードだけを抽出する。
 *
 * ★ここが誤配信を防ぐ唯一の関門。条件を緩めてはならない。
 */
export function selectFeedItems(input: FeedInput): PublishableItem[] {
  const items: PublishableItem[] = [];

  for (const post of input.posts) {
    if (post.platform !== 'podcast') continue;

    // 承認済み、または既に公開済みのものだけを対象にする。
    // （公開済みを含めるのは、公開後もフィードに残り続ける必要があるため）
    if (!isPublishable(post.status) && post.status !== '公開済み') continue;

    if (!post.scheduledAt) continue;
    const pubDate = new Date(post.scheduledAt);
    if (Number.isNaN(pubDate.getTime())) continue;

    // 公開時刻が到来していないものは出力しない＝これが予約公開の実装。
    if (pubDate.getTime() > input.now.getTime()) continue;

    const episode = input.podcastEpisodes.get(post.episodeId);
    if (!episode) continue;

    const audio = input.audioDeliverables.get(post.episodeId);
    // 音声の実体とバイト数が揃っていないものは配信しない。
    // enclosure の length が誤っているとApple Podcastsで再生不具合が起きる。
    if (!audio?.mediaUrl || !audio.fileSize) continue;

    items.push({ post, episode, audio, pubDate });
  }

  // 新しい順。同時刻なら話数の降順で安定させる。
  return items.sort(
    (a, b) =>
      b.pubDate.getTime() - a.pubDate.getTime() ||
      b.episode.episodeNumber - a.episode.episodeNumber,
  );
}

function renderItem(item: PublishableItem, input: FeedInput): string {
  const { post, episode, audio, pubDate } = item;
  const enclosureUrl = applyOp3Prefix(
    audio.mediaUrl!,
    input.enableOp3 !== false,
  );

  const lines = [
    '    <item>',
    `      <title>${escapeXml(post.title)}</title>`,
    // isPermaLink="false" を明示しないと、guidをURLとして解釈する配信先がある。
    `      <guid isPermaLink="false">${escapeXml(episode.guid)}</guid>`,
    `      <pubDate>${toRfc822(pubDate)}</pubDate>`,
    `      <link>${escapeXml(input.show.link)}</link>`,
    `      <enclosure url="${escapeXml(enclosureUrl)}" length="${audio.fileSize}" type="audio/mpeg"/>`,
    `      <itunes:duration>${toDuration(episode.durationSec)}</itunes:duration>`,
    `      <itunes:episode>${episode.episodeNumber}</itunes:episode>`,
    `      <itunes:explicit>${episode.explicit ? 'true' : 'false'}</itunes:explicit>`,
    `      <description>${wrapCdata(episode.contentHtml)}</description>`,
    `      <itunes:summary>${escapeXml(episode.itunesSummary)}</itunes:summary>`,
    `      <content:encoded>${wrapCdata(episode.contentHtml)}</content:encoded>`,
  ];

  if (episode.season !== undefined) {
    lines.push(`      <itunes:season>${episode.season}</itunes:season>`);
  }
  if (episode.episodeImageUrl) {
    lines.push(`      <itunes:image href="${escapeXml(episode.episodeImageUrl)}"/>`);
  }
  if (episode.keywords.length > 0) {
    lines.push(`      <itunes:keywords>${escapeXml(episode.keywords.join(','))}</itunes:keywords>`);
  }
  for (const person of episode.persons) {
    const desc = person.description
      ? ` href="${escapeXml(input.show.link)}"`
      : '';
    lines.push(
      `      <podcast:person role="${escapeXml(person.role)}"${desc}>${escapeXml(person.name)}</podcast:person>`,
    );
  }
  if (episode.chapters.length > 0) {
    const url = `${input.chaptersBaseUrl.replace(/\/$/, '')}/${episode.episodeId}/chapters.json`;
    lines.push(
      `      <podcast:chapters url="${escapeXml(url)}" type="application/json+chapters"/>`,
    );
  }

  lines.push('    </item>');
  return lines.join('\n');
}

/** RSS 2.0 + iTunes + Podcasting 2.0 のフィードを生成する。 */
export function generateFeed(input: FeedInput): string {
  const { show } = input;
  const items = selectFeedItems(input);
  const lastBuild = items[0]?.pubDate ?? input.now;

  const header = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"',
    '     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"',
    '     xmlns:podcast="https://podcastindex.org/namespace/1.0"',
    '     xmlns:content="http://purl.org/rss/1.0/modules/content/"',
    '     xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(show.title)}</title>`,
    `    <link>${escapeXml(show.link)}</link>`,
    `    <description>${wrapCdata(show.description)}</description>`,
    `    <language>${escapeXml(show.language)}</language>`,
    `    <lastBuildDate>${toRfc822(lastBuild)}</lastBuildDate>`,
    `    <itunes:author>${escapeXml(show.author)}</itunes:author>`,
    '    <itunes:owner>',
    `      <itunes:name>${escapeXml(show.ownerName)}</itunes:name>`,
    `      <itunes:email>${escapeXml(show.ownerEmail)}</itunes:email>`,
    '    </itunes:owner>',
    `    <itunes:image href="${escapeXml(show.coverImageUrl)}"/>`,
    `    <itunes:explicit>${show.explicit ? 'true' : 'false'}</itunes:explicit>`,
    `    <itunes:type>${escapeXml(show.type)}</itunes:type>`,
    show.subCategory
      ? `    <itunes:category text="${escapeXml(show.category)}"><itunes:category text="${escapeXml(show.subCategory)}"/></itunes:category>`
      : `    <itunes:category text="${escapeXml(show.category)}"/>`,
  ];

  if (show.copyright) {
    header.push(`    <copyright>${escapeXml(show.copyright)}</copyright>`);
  }

  const body = items.map((item) => renderItem(item, input));

  return [...header, ...body, '  </channel>', '</rss>', ''].join('\n');
}

/** Podcasting 2.0 の JSON Chapters 形式を生成する。 */
export function generateChaptersJson(episode: PodcastEpisode): string {
  return JSON.stringify(
    {
      version: '1.2.0',
      chapters: episode.chapters.map((c) => ({
        startTime: c.startTime,
        title: c.title,
      })),
    },
    null,
    2,
  );
}
