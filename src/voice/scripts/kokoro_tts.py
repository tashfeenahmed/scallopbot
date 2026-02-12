#!/usr/bin/env python3
"""
Kokoro TTS wrapper script
Reads text from stdin, outputs WAV audio to stdout or file
"""

import sys
import json
import argparse
import tempfile
import os
import subprocess
import logging

# Suppress all logging from kokoro-onnx and other libraries
logging.disable(logging.CRITICAL)
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'  # Suppress TensorFlow logs if any

def main():
    parser = argparse.ArgumentParser(description='Synthesize speech using Kokoro TTS')
    parser.add_argument('--voice', default='af_heart', help='Voice name (e.g., af_heart, af_bella, am_adam)')
    parser.add_argument('--lang', default='a', help='Language code: a (American), b (British)')
    parser.add_argument('--speed', type=float, default=1.0, help='Speech speed (0.5-2.0)')
    parser.add_argument('--output', default=None, help='Output file path (if not using stdout)')
    parser.add_argument('--text', default=None, help='Text to synthesize (if not using stdin)')
    parser.add_argument('--format', default='wav', help='Output format: wav, opus')
    parser.add_argument('--info-only', action='store_true', help='Only output info JSON, not audio')
    args = parser.parse_args()

    # Try kokoro-onnx first (lighter weight), fall back to kokoro
    kokoro_onnx = False
    try:
        import kokoro_onnx as ko
        kokoro_onnx = True
    except ImportError:
        try:
            from kokoro import KPipeline
        except ImportError:
            error_result = {
                'error': 'Kokoro not installed. Run: pip install kokoro-onnx (or pip install kokoro)',
                'success': False
            }
            if args.info_only:
                print(json.dumps(error_result))
            else:
                sys.stderr.write(json.dumps(error_result))
            sys.exit(1)

    # Get text
    text = args.text
    if not text:
        text = sys.stdin.read().strip()

    if not text:
        error_result = {'error': 'No text provided', 'success': False}
        if args.info_only:
            print(json.dumps(error_result))
        else:
            sys.stderr.write(json.dumps(error_result))
        sys.exit(1)

    try:
        if kokoro_onnx:
            # Using kokoro-onnx (lightweight ONNX version)
            import numpy as np
            from pathlib import Path

            # Find model files in standard locations
            cache_dir = Path.home() / '.cache' / 'kokoro'
            model_file = cache_dir / 'kokoro-v1.0.onnx'
            voices_file = cache_dir / 'voices-v1.0.bin'

            # Fall back to current directory if not in cache
            if not model_file.exists():
                model_file = Path('kokoro-v1.0.onnx')
            if not voices_file.exists():
                voices_file = Path('voices-v1.0.bin')

            # Initialize model
            model = ko.Kokoro(str(model_file), str(voices_file))

            # Generate audio
            samples, sample_rate = model.create(
                text,
                voice=args.voice,
                speed=args.speed,
            )

            # Convert to bytes
            audio_data = (samples * 32767).astype(np.int16).tobytes()

        else:
            # Using official kokoro package
            import soundfile as sf
            import io
            import numpy as np

            pipeline = KPipeline(lang_code=args.lang)

            # Generate audio
            audio_chunks = []
            for _, _, audio in pipeline(text, voice=args.voice, speed=args.speed):
                audio_chunks.append(audio)

            if not audio_chunks:
                raise Exception('No audio generated')

            # Concatenate chunks
            audio_array = np.concatenate(audio_chunks) if len(audio_chunks) > 1 else audio_chunks[0]
            sample_rate = 24000

            # Convert to bytes (16-bit PCM)
            audio_data = (audio_array * 32767).astype(np.int16).tobytes()

        # Output info if requested
        if args.info_only:
            duration = len(audio_data) / (sample_rate * 2)  # 2 bytes per sample (16-bit)
            print(json.dumps({
                'success': True,
                'sample_rate': sample_rate,
                'duration': duration,
                'format': 'pcm_s16le',
                'size': len(audio_data),
            }))
            return

        # Write output
        if args.output:
            # Write to file
            import wave
            with wave.open(args.output, 'wb') as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)  # 16-bit
                wf.setframerate(sample_rate)
                wf.writeframes(audio_data)

            # Convert to opus if requested
            if args.format == 'opus':
                opus_file = args.output.replace('.wav', '.opus')
                subprocess.run(
                    ['ffmpeg', '-y', '-i', args.output, '-c:a', 'libopus', '-b:a', '32k', opus_file],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True,
                )
                os.unlink(args.output)
                args.output = opus_file

            sys.stderr.write(json.dumps({
                'success': True,
                'file': args.output,
                'duration': len(audio_data) / (sample_rate * 2),
            }))
        else:
            # Write WAV to stdout
            import wave
            import io

            wav_buffer = io.BytesIO()
            with wave.open(wav_buffer, 'wb') as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)  # 16-bit
                wf.setframerate(sample_rate)
                wf.writeframes(audio_data)

            sys.stdout.buffer.write(wav_buffer.getvalue())

    except Exception as e:
        error_result = {'error': f'Synthesis failed: {str(e)}', 'success': False}
        if args.info_only:
            print(json.dumps(error_result))
        else:
            sys.stderr.write(json.dumps(error_result))
        sys.exit(1)

if __name__ == '__main__':
    main()
