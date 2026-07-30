#!/usr/bin/env python3
"""faster-whisper で単語単位のタイムコード付き文字起こしを行う。

TypeScript側から呼び出され、結果をJSONで標準出力に返す。
Pythonに閉じ込めるのは faster-whisper の呼び出しだけで、
後処理（字幕の組み立て・話者の割り当て）はすべてTypeScript側で行う。
テスト可能な範囲をTypeScript側に寄せるため。

使い方:
  python3 scripts/transcribe.py <音声ファイル> [--model small] [--language ja]
                                [--device auto] [--vad]

出力（標準出力・JSON）:
  {
    "language": "ja",
    "durationSec": 40.0,
    "words": [{"startSec": 0.1, "endSec": 0.5, "text": "採用", "probability": 0.98}],
    "segments": [{"startSec": 0.0, "endSec": 4.2, "text": "..."}],
    "timings": {
      "modelLoadSec": 1.2,    モデルの読み込み（初期化）
      "preprocessSec": 0.3,   音声デコード・特徴量抽出・言語検出
      "inferenceSec": 8.1,    実際のデコード（ここが音声尺に対して伸びる処理）
      "postprocessSec": 0.01, Python側でのオブジェクト整形
      "jsonSec": 0.02,        JSON直列化
      "totalSec": 9.63
    }
  }

「7.5秒の音声に9.6秒かかった」がモデル読込込みか純粋な推論時間かを
区別するために、上記5つの内訳を必ず計測して返す。
"""

from __future__ import annotations

import argparse
import json
import sys
import time


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    # 既定は small。精度が要る場合は large-v3 を指定する（初回はモデルの
    # ★既定は large-v3。実測で small は業務用語を誤認識した
    # （「自己紹介」→「事故紹介」）。初回は約3GBのダウンロードが発生する。
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--language", default="ja")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="int8")
    # 無音区間の除去（VAD）は既定で無効。★沈黙・間は作品の一部であり、
    # 文字起こしの都合で時間軸を詰めてはならない。
    parser.add_argument("--vad", action="store_true")
    # 固有名詞・専門用語の認識精度を上げるための語彙ヒント。
    # 日本語では同音異義語の誤認識（例: 自己紹介 → 事故紹介）が起きやすく、
    # ここに用語を渡すだけで実測で改善する。
    parser.add_argument("--initial-prompt", default=None)
    parser.add_argument("--hotwords", default=None)
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            json.dumps(
                {
                    "error": "faster_whisper が見つかりません。"
                    "`.venv/bin/pip install faster-whisper` を実行してください。"
                }
            ),
            file=sys.stdout,
        )
        return 2

    try:
        t_start = time.perf_counter()

        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
        )
        t_model_loaded = time.perf_counter()

        # transcribe() 自体は音声デコード・特徴量抽出・言語検出を同期的に行い
        # (info が duration/language を必要とするため)、実際の逐次デコードは
        # 返された segments ジェネレータを消費するまで走らない。
        segments_gen, info = model.transcribe(
            args.audio,
            language=args.language,
            # 単語単位のタイムコードを得る。字幕の改行位置と話者の割り当てに使う。
            word_timestamps=True,
            vad_filter=args.vad,
            condition_on_previous_text=False,
            initial_prompt=args.initial_prompt,
            hotwords=args.hotwords,
        )
        t_preprocessed = time.perf_counter()

        # ★ここで list() 化することで、実際の推論（デコード）だけを
        # inferenceSec として切り出して計測する。
        segments = list(segments_gen)
        t_inferred = time.perf_counter()

        words = []
        segment_list = []
        for segment in segments:
            segment_list.append(
                {
                    "startSec": round(segment.start, 3),
                    "endSec": round(segment.end, 3),
                    "text": segment.text.strip(),
                }
            )
            for word in segment.words or []:
                words.append(
                    {
                        "startSec": round(word.start, 3),
                        "endSec": round(word.end, 3),
                        "text": word.word.strip(),
                        "probability": round(word.probability, 4),
                    }
                )
        t_postprocessed = time.perf_counter()

        payload = {
            "language": info.language,
            "languageProbability": round(info.language_probability, 4),
            "durationSec": round(info.duration, 3),
            "model": args.model,
            "vadFilter": bool(args.vad),
            "initialPrompt": args.initial_prompt,
            "hotwords": args.hotwords,
            "words": words,
            "segments": segment_list,
        }
        # jsonSec 計測用に一度直列化する（内容は最終出力とは別に破棄する）。
        json.dumps(payload, ensure_ascii=False)
        t_json = time.perf_counter()

        payload["timings"] = {
            "modelLoadSec": round(t_model_loaded - t_start, 4),
            "preprocessSec": round(t_preprocessed - t_model_loaded, 4),
            "inferenceSec": round(t_inferred - t_preprocessed, 4),
            "postprocessSec": round(t_postprocessed - t_inferred, 4),
            "jsonSec": round(t_json - t_postprocessed, 4),
            "totalSec": round(t_json - t_start, 4),
        }
        # timings を含めた最終版を出力する（先に作った output は破棄）。
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    except Exception as error:  # noqa: BLE001 — 失敗理由をJSONで返したい
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
