import { useState, useEffect, useRef, useCallback } from 'react';

interface TimelinePlayerProps {
  minTime: number;
  maxTime: number;
  cutoff: number;
  onCutoffChange: (t: number) => void;
  darkMode: boolean;
}

const PLAY_DURATION_MS = 15000; // full sweep takes 15 seconds

function formatDate(ts: number): string {
  const d = new Date(ts);
  const mon = d.toLocaleString('default', { month: 'short' });
  const day = d.getDate();
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${mon} ${day}, ${h}:${m}`;
}

export default function TimelinePlayer({ minTime, maxTime, cutoff, onCutoffChange, darkMode }: TimelinePlayerProps) {
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number>(0);
  const startRef = useRef<number>(0);
  const startCutoffRef = useRef<number>(0);

  const range = maxTime - minTime || 1;

  const animate = useCallback((now: number) => {
    const elapsed = now - startRef.current;
    const progress = Math.min(elapsed / PLAY_DURATION_MS, 1);
    // Ease-in-out cubic for smoother playback
    const eased = progress < 0.5
      ? 4 * progress * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 3) / 2;
    const newCutoff = startCutoffRef.current + (maxTime - startCutoffRef.current) * eased;
    onCutoffChange(newCutoff);

    if (progress < 1) {
      rafRef.current = requestAnimationFrame(animate);
    } else {
      setPlaying(false);
    }
  }, [maxTime, onCutoffChange]);

  const handlePlay = useCallback(() => {
    if (playing) {
      cancelAnimationFrame(rafRef.current);
      setPlaying(false);
      return;
    }
    // If at end, reset to start
    const start = cutoff >= maxTime - range * 0.01 ? minTime : cutoff;
    onCutoffChange(start);
    startCutoffRef.current = start;
    startRef.current = performance.now();
    setPlaying(true);
    rafRef.current = requestAnimationFrame(animate);
  }, [playing, cutoff, minTime, maxTime, range, onCutoffChange, animate]);

  useEffect(() => {
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <div className="flex items-center gap-2" style={{ minWidth: 180 }}>
      <button
        onClick={handlePlay}
        className="flex items-center justify-center shrink-0 transition-opacity hover:opacity-100"
        style={{ opacity: 0.85, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
      >
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 10 10" fill="white">
            <rect x="1" y="1" width="3" height="8" rx="0.5" />
            <rect x="6" y="1" width="3" height="8" rx="0.5" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 10 10" fill="white">
            <polygon points="2,1 9,5 2,9" />
          </svg>
        )}
      </button>

      <input
        type="range"
        min={minTime}
        max={maxTime}
        value={cutoff}
        onChange={(e) => {
          if (playing) {
            cancelAnimationFrame(rafRef.current);
            setPlaying(false);
          }
          onCutoffChange(Number(e.target.value));
        }}
        className="timeline-slider flex-1"
        style={{ height: 4 }}
      />
      <span style={{ fontSize: 10, lineHeight: 1, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap' }}>{formatDate(cutoff)}</span>
    </div>
  );
}
