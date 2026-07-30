/**
 * ステータス定義と遷移ルール。
 *
 * このファイルが「何が投稿されうるか」の単一の正である。
 * CLI・管理画面API・RSS Worker はすべてここを参照し、独自の判定を持たない。
 * 投稿可否の判断を1か所に集約することが、誤投稿を防ぐ最大の防御線になる。
 *
 * @see docs/04-approval-flow.md
 */

/** 投稿（posts）のステータス。docs/05-data-structure.md 5.3 の9状態。 */
export const POST_STATUSES = [
  '素材準備中',
  'AI生成待ち',
  // ingest 完了でここに入る。Premiereでの作業待ちを表す。
  '編集中',
  '確認待ち',
  '修正中',
  '承認済み',
  '予約投稿済み',
  '公開済み',
  '投稿失敗',
] as const;

export type PostStatus = (typeof POST_STATUSES)[number];

/**
 * 投稿処理の対象になりうるステータスのホワイトリスト。
 *
 * ★否定条件（「確認待ち以外」等）を絶対に書かないこと。
 * 将来ステータスを追加しても、ここに明示的に足さない限り投稿対象にならない。
 */
export const PUBLISHABLE_STATUSES: readonly PostStatus[] = ['承認済み'];

/**
 * 「すでに媒体側に渡した」ことを意味するステータス。
 * 再投稿・承認取消を禁止する判定に使う。
 */
export const HANDED_OFF_STATUSES: readonly PostStatus[] = [
  '予約投稿済み',
  '公開済み',
];

/** 許可された遷移のみを列挙する。ここに無い遷移はすべて拒否される。 */
const ALLOWED_TRANSITIONS: Readonly<Record<PostStatus, readonly PostStatus[]>> = {
  素材準備中: ['AI生成待ち'],
  // ingest 実行で編集中へ。素材の入れ直しがあれば戻せる。
  'AI生成待ち': ['編集中', '素材準備中'],
  // 書き出し検知で確認待ちへ。AI再生成のためAI生成待ちにも戻せる。
  編集中: ['確認待ち', 'AI生成待ち'],
  // 編集に戻したい場合は編集中へ差し戻せる。
  確認待ち: ['修正中', '承認済み', '編集中', '素材準備中'],
  修正中: ['確認待ち', '承認済み', '編集中'],
  // 承認取消で確認待ちに戻せる。予約投稿済みへはシステムのみが進める。
  承認済み: ['確認待ち', '修正中', '予約投稿済み', '投稿失敗'],
  // 投稿停止で承認済みに戻せる（媒体側の予約解除が成功した場合のみ）。
  予約投稿済み: ['公開済み', '投稿失敗', '承認済み'],
  // 公開後は取り消せない。アーカイブ相当の遷移も持たせない。
  公開済み: [],
  投稿失敗: ['確認待ち', '修正中', '承認済み'],
};

export type TransitionCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * ステータス遷移が許可されているかを判定する。
 * 同一ステータスへの遷移は「変更なし」として許可する（冪等な保存を許すため）。
 */
export function canTransition(from: PostStatus, to: PostStatus): TransitionCheck {
  if (from === to) return { ok: true };

  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      reason: `「${from}」から「${to}」への変更は許可されていません`,
    };
  }
  return { ok: true };
}

/** 投稿処理が拾ってよいステータスかどうか。 */
export function isPublishable(status: PostStatus): boolean {
  return PUBLISHABLE_STATUSES.includes(status);
}

/** 承認取消が可能か。媒体側に渡した後は取り消せない。 */
export function canUnapprove(status: PostStatus): TransitionCheck {
  if (status !== '承認済み') {
    return { ok: false, reason: '承認済みのものだけ取り消せます' };
  }
  return { ok: true };
}

/**
 * 再投稿が可能か。
 * post_url がある＝すでに公開されているため、重複投稿を防ぐために拒否する。
 */
export function canRepost(
  status: PostStatus,
  postUrl: string | undefined,
): TransitionCheck {
  if (postUrl) {
    return {
      ok: false,
      reason: '公開URLが記録されているため再投稿できません（重複投稿の防止）',
    };
  }
  if (status !== '投稿失敗') {
    return { ok: false, reason: '投稿失敗のものだけ再投稿できます' };
  }
  return { ok: true };
}
