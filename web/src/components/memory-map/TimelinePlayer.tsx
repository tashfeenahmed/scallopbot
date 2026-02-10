import { useState, useEffect, useRef, useCallback } from 'react';

interface TimelinePlayerProps {
  minTime: number;
  maxTime: number;
  cutoff: number;
  onCutoffChange: (t: number) => void;
}

const PLAY_DURATION_MS = 6000; // full sweep takes 6 seconds

function formatDate(ts: number): string {
  const d = new Date(ts);
  const mon = d.toLocaleString('default', { month: 'short' });
  const day = d.getDate();
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${mon} ${day}, ${h}:${m}`;
}

export default function TimelinePlayer({ minTime, maxTime, cutoff, onCutoffChange }: TimelinePlayerProps) {
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number>(0);
  const startRef = useRef<number>(0);
  const startCutoffRef = useRef<number>(0);

  const range = maxTime - minTime || 1;

  const animate = useCallback((now: number) => {
    const elapsed = now - startRef.current;
    const progress = Math.min(elapsed / PLAY_DURATION_MS, 1);
    const newCutoff = startCutoffRef.current + (maxTime - startCutoffRef.current) * progress;
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

  const sliderPercent = ((cutoff - minTime) / range) * 100;

  return (
    <div className="flex items-center gap-2" style={{ minWidth: 180 }}>
      <button
        onClick={handlePlay}
        className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-all"
        style={{
          backgroundColor: playing ? 'rgba(239,68,68,0.25)' : 'rgba(96,165,250,0.25)',
          border: `1px solid ${playing ? 'rgba(239,68,68,0.5)' : 'rgba(96,165,250,0.5)'}`,
          backdropFilter: 'blur(8px)',
        }}
      >
        {playing ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" className="text-red-400">
            <rect x="1" y="1" width="3" height="8" rx="0.5" />
            <rect x="6" y="1" width="3" height="8" rx="0.5" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" className="text-blue-400">
            <polygon points="2,1 9,5 2,9" />
          </svg>
        )}
      </button>

      <div className="flex-1 flex flex-col gap-0.5">
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
          className="timeline-slider w-full"
          style={{
            height: 4,
            accentColor: '#60a5fa',
          }}
        />
        <span className="text-[10px] text-gray-500 leading-none">{formatDate(cutoff)}</span>
      </div>
    </div>
  );
}
