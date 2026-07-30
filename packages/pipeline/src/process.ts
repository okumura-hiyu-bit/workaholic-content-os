/**
 * キャンセル可能な子プロセス実行は packages/media が持つ（ffmpeg/whisper
 * どちらの呼び出しにも使う、media側の関心事のため）。pipeline はそれを
 * re-export するだけで、実装を重複させない。
 */
export * from '../../media/src/process.ts';
