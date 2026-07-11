/**
 * Tests for enhanced tool loop detection.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolLoopDetector } from './tool-loop-detector.js';

const SESSION = 'test-session';

describe('ToolLoopDetector', () => {
  let detector: ToolLoopDetector;

  beforeEach(() => {
    detector = new ToolLoopDetector({
      historySize: 20,
      warningThreshold: 4,
      criticalThreshold: 7,
      circuitBreakerThreshold: 10,
    });
  });

  describe('no detection', () => {
    it('returns null when no calls recorded', () => {
      expect(detector.detect(SESSION)).toBeNull();
    });

    it('returns null for varied tool calls', () => {
      detector.recordToolCall(SESSION, 'web_search', { q: 'cats' });
      detector.recordToolOutcome(SESSION, undefined, 'result1');
      detector.recordToolCall(SESSION, 'read_file', { path: '/a.txt' });
      detector.recordToolOutcome(SESSION, undefined, 'result2');
      detector.recordToolCall(SESSION, 'bash', { command: 'ls' });
      detector.recordToolOutcome(SESSION, undefined, 'result3');

      expect(detector.detect(SESSION)).toBeNull();
    });
  });

  describe('generic_repeat detection', () => {
    it('detects warning after threshold identical calls', () => {
      for (let i = 0; i < 4; i++) {
        detector.recordToolCall(SESSION, 'web_search', { q: 'weather' });
      }

      const result = detector.detect(SESSION);
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('generic_repeat');
      expect(result!.severity).toBe('warning');
      expect(result!.count).toBe(4);
    });

    it('does not block repeated arguments without evidence that results stopped changing', () => {
      for (let i = 0; i < 7; i++) {
        detector.recordToolCall(SESSION, 'web_search', { q: 'weather' }, `changing-${i}`);
        detector.recordToolOutcome(SESSION, `changing-${i}`, `result-${i}`);
      }

      const result = detector.detect(SESSION);
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('generic_repeat');
      expect(result!.severity).toBe('warning');
    });

    it('does not confuse different tools that happen to use the same arguments', () => {
      for (let i = 0; i < 8; i++) {
        detector.recordToolCall(SESSION, `tool-${i}`, { id: 'same' });
      }

      expect(detector.detect(SESSION)).toBeNull();
    });
  });

  describe('no_progress detection', () => {
    it('detects when same tool returns same result repeatedly', () => {
      for (let i = 0; i < 4; i++) {
        detector.recordToolCall(SESSION, 'web_search', { q: 'weather' }, `call-${i}`);
        detector.recordToolOutcome(SESSION, `call-${i}`, 'identical result');
      }

      const result = detector.detect(SESSION);
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('no_progress');
      expect(result!.severity).toBe('warning');
      expect(result!.toolName).toBe('web_search');
    });

    it('does not trigger when results differ', () => {
      for (let i = 0; i < 4; i++) {
        detector.recordToolCall(SESSION, 'web_search', { q: 'weather' }, `call-${i}`);
        detector.recordToolOutcome(SESSION, `call-${i}`, `different result ${i}`);
      }

      // This will trigger generic_repeat (same args) but NOT no_progress
      const result = detector.detect(SESSION);
      if (result) {
        expect(result.kind).not.toBe('no_progress');
      }
    });

    it('blocks identical arguments and outcomes at the critical threshold', () => {
      for (let i = 0; i < 7; i++) {
        detector.recordToolCall(SESSION, 'web_search', { q: 'weather' }, `blocked-${i}`);
        detector.recordToolOutcome(SESSION, `blocked-${i}`, 'unchanged');
      }

      const result = detector.detect(SESSION);
      expect(result).toMatchObject({ kind: 'no_progress', severity: 'block', count: 7 });
    });
  });

  describe('ping_pong detection', () => {
    it('detects A-B-A-B alternation pattern', () => {
      // Need enough alternations to reach warning threshold
      for (let i = 0; i < 5; i++) {
        detector.recordToolCall(SESSION, 'read_file', { path: '/a.txt' });
        detector.recordToolCall(SESSION, 'web_search', { q: 'docs' });
      }

      const result = detector.detect(SESSION);
      expect(result).toMatchObject({ kind: 'ping_pong', severity: 'warning', count: 10 });
    });

    it('blocks an alternating loop only when both calls return stable outcomes', () => {
      for (let i = 0; i < 4; i++) {
        detector.recordToolCall(SESSION, 'read_file', { path: '/a.txt' }, `read-${i}`);
        detector.recordToolOutcome(SESSION, `read-${i}`, 'same read result');
        detector.recordToolCall(SESSION, 'web_search', { q: 'docs' }, `search-${i}`);
        detector.recordToolOutcome(SESSION, `search-${i}`, 'same search result');
      }

      expect(detector.detect(SESSION)).toMatchObject({
        kind: 'ping_pong',
        severity: 'block',
        count: 8,
      });
    });
  });

  describe('circuit_breaker', () => {
    it('blocks after too many no-progress calls', () => {
      for (let i = 0; i < 11; i++) {
        detector.recordToolCall(SESSION, 'bash', { cmd: 'failing' }, `cb-${i}`);
        detector.recordToolOutcome(SESSION, `cb-${i}`, 'same error');
      }

      const result = detector.detect(SESSION);
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('circuit_breaker');
      expect(result!.severity).toBe('block');
    });
  });

  describe('repeated failure family detection', () => {
    it('warns and then blocks changing tools that hit the same typed boundary error', () => {
      for (let i = 0; i < 3; i++) {
        detector.recordToolCall(SESSION, `tool_${i}`, { attempt: i }, `typed-${i}`);
        detector.recordToolOutcome(
          SESSION,
          `typed-${i}`,
          '[TOOL_ERROR code=SAFETY_LOCAL_INTENT_REQUIRED] Explicit change request required.',
        );
      }
      expect(detector.detect(SESSION)).toMatchObject({
        kind: 'repeated_failure', severity: 'warning', count: 3,
      });

      for (let i = 3; i < 6; i++) {
        detector.recordToolCall(SESSION, `different_${i}`, { attempt: i }, `typed-${i}`);
        detector.recordToolOutcome(
          SESSION,
          `typed-${i}`,
          '[TOOL_ERROR code=SAFETY_LOCAL_INTENT_REQUIRED] Explicit change request required.',
        );
      }
      expect(detector.detect(SESSION)).toMatchObject({
        kind: 'repeated_failure', severity: 'block', count: 6,
      });
    });

    it('resets after a successful result', () => {
      for (let i = 0; i < 3; i++) {
        detector.recordToolCall(SESSION, 'run_code', { attempt: i }, `failure-${i}`);
        detector.recordToolOutcome(SESSION, `failure-${i}`, '[TOOL_ERROR code=POLICY] denied');
      }
      detector.recordToolCall(SESSION, 'read_file', { path: 'ok' }, 'success');
      detector.recordToolOutcome(SESSION, 'success', 'verified output');
      expect(detector.detect(SESSION)?.kind).not.toBe('repeated_failure');
    });
  });

  describe('clearSession', () => {
    it('removes all state for a session', () => {
      for (let i = 0; i < 5; i++) {
        detector.recordToolCall(SESSION, 'web_search', { q: 'test' });
      }
      expect(detector.detect(SESSION)).not.toBeNull();

      detector.clearSession(SESSION);
      expect(detector.detect(SESSION)).toBeNull();
    });

    it('does not affect other sessions', () => {
      for (let i = 0; i < 5; i++) {
        detector.recordToolCall('sess-a', 'web_search', { q: 'test' });
        detector.recordToolCall('sess-b', 'web_search', { q: 'test' });
      }

      detector.clearSession('sess-a');
      expect(detector.detect('sess-a')).toBeNull();
      expect(detector.detect('sess-b')).not.toBeNull();
    });
  });

  describe('history bounding', () => {
    it('keeps only historySize entries', () => {
      // Fill with 25 unique calls (historySize=20)
      for (let i = 0; i < 25; i++) {
        detector.recordToolCall(SESSION, 'web_search', { q: `query-${i}` });
      }

      // The oldest entries should be gone, no repeat pattern for the recent ones
      expect(detector.detect(SESSION)).toBeNull();
    });
  });
});
