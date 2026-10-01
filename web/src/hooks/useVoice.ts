import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Push-to-talk for the chat composer: records with MediaRecorder, sends the
 * clip to the server's STT (/api/voice/transcribe) and can play a TTS reply
 * (/api/voice/speak). Uses the same voice pipeline as Telegram voice notes.
 */

export type VoiceState = 'idle' | 'recording' | 'transcribing' | 'speaking';

export interface VoiceStatus {
  stt: boolean;
  tts: boolean;
}

/** Strip markdown so TTS reads words, not symbols. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' code block omitted. ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const type of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported?.(type)) return type;
  }
  return undefined;
}

/** `enabled`: fetch server voice capabilities once the user is signed in. */
export function useVoice(enabled = true) {
  const [status, setStatus] = useState<VoiceStatus>({ stt: false, tts: false });
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const supported = typeof window !== 'undefined'
    && typeof MediaRecorder !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch('/api/voice/status')
      .then(res => (res.ok ? res.json() : { stt: false, tts: false }))
      .then((s: VoiceStatus) => { if (!cancelled) setStatus({ stt: !!s.stt, tts: !!s.tts }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [enabled]);

  const startingRef = useRef<Promise<void> | null>(null);

  const start = useCallback(async () => {
    if (!supported || recorderRef.current || startingRef.current) return;
    setError(null);
    audioRef.current?.pause();
    startingRef.current = (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = pickMimeType();
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        chunksRef.current = [];
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
        recorder.start();
        recorderRef.current = recorder;
        setState('recording');
      } catch {
        setError('Microphone permission denied');
        setState('idle');
      }
    })();
    await startingRef.current;
    startingRef.current = null;
  }, [supported]);

  /** Stop recording and resolve with the transcript ('' when nothing usable). */
  const stop = useCallback(async (): Promise<string> => {
    // A quick release can land while the mic permission prompt is still open.
    if (startingRef.current) await startingRef.current;
    const recorder = recorderRef.current;
    if (!recorder) return '';
    recorderRef.current = null;
    const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
    recorder.stop();
    await stopped;
    recorder.stream.getTracks().forEach(track => track.stop());
    const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
    chunksRef.current = [];
    if (blob.size < 1000) {
      setState('idle');
      return '';
    }
    setState('transcribing');
    try {
      const res = await fetch('/api/voice/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': blob.type },
        body: blob,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { text } = await res.json() as { text?: string };
      if (!text) setError('Could not understand the audio');
      return text ?? '';
    } catch {
      setError('Transcription failed');
      return '';
    } finally {
      setState('idle');
    }
  }, []);

  const speak = useCallback(async (markdown: string) => {
    const text = speakableText(markdown);
    if (!text) return;
    setState('speaking');
    try {
      const res = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      audioRef.current?.pause();
      const audio = new Audio(url);
      audioRef.current = audio;
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        audio.onpause = () => resolve();
        audio.play().catch(() => resolve());
      });
      URL.revokeObjectURL(url);
    } catch {
      setError('Could not play the spoken reply');
    } finally {
      setState(s => (s === 'speaking' ? 'idle' : s));
    }
  }, []);

  return { supported, status, state, error, start, stop, speak };
}
