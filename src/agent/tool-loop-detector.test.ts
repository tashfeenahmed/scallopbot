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
    const TYPED = '[TOOL_ERROR code=SAFETY_LOCAL_INTENT_REQUIRED] Explicit change request required.';

    // Interactive-chat escalation: warning at the 2nd failure of a family and a
    // turn-ending block at the 4th across any arguments (was 3 and 6).
    it('warns at the second failure and ends the turn at the fourth across changing tools', () => {
      for (let i = 0; i < 2; i++) {
        detector.recordToolCall(SESSION, `tool_${i}`, { attempt: i }, `typed-${i}`);
        detector.recordToolOutcome(SESSION, `typed-${i}`, TYPED);
      }
      expect(detector.detect(SESSION)).toMatchObject({
        kind: 'repeated_failure', severity: 'warning', count: 2,
      });

      detector.recordToolCall(SESSION, 'tool_2', { attempt: 2 }, 'typed-2');
      detector.recordToolOutcome(SESSION, 'typed-2', TYPED);
      expect(detector.detect(SESSION)).toMatchObject({ severity: 'warning', count: 3 });

      detector.recordToolCall(SESSION, 'tool_3', { attempt: 3 }, 'typed-3');
      detector.recordToolOutcome(SESSION, 'typed-3', TYPED);
      expect(detector.detect(SESSION)).toMatchObject({
        kind: 'repeated_failure', severity: 'block', scope: 'turn', count: 4,
      });
    });

    it('refuses only the exact call after three identical failures', () => {
      const args = { command: 'curl -X POST https://api.notion.com/v1/pages' };
      for (let i = 0; i < 3; i++) {
        detector.recordToolCall(SESSION, 'bash', args, `same-${i}`);
        detector.recordToolOutcome(SESSION, `same-${i}`, 'Error: HTTP 400 body.properties.Name.id should be defined');
      }
      expect(detector.detect(SESSION)).toMatchObject({
        kind: 'repeated_failure', severity: 'block', scope: 'call', toolName: 'bash', count: 3,
      });
      expect(detector.isCallBlocked(SESSION, 'bash', { ...args })).toMatchObject({ toolName: 'bash', count: 3 });
      expect(detector.isCallBlocked(SESSION, 'bash', { command: 'curl -X POST https://api.notion.com/v1/pages -d x' })).toBeNull();
      expect(detector.isCallBlocked(SESSION, 'run_code', args)).toBeNull();
    });

    it('carries the original family through a refused identical retry into the turn breaker', () => {
      const args = { action: 'create', database_id: 'gym' };
      for (let i = 0; i < 3; i++) {
        detector.recordToolCall(SESSION, 'notion', args, `n-${i}`);
        detector.recordToolOutcome(SESSION, `n-${i}`, TYPED);
      }
      detector.recordToolCall(SESSION, 'notion', args, 'n-refused');
      detector.recordToolOutcome(
        SESSION,
        'n-refused',
        '[TOOL_ERROR code=IDENTICAL_CALL_BLOCKED] Identical call already failed 3 times; change the arguments or stop.',
      );
      expect(detector.detect(SESSION)).toMatchObject({
        kind: 'repeated_failure', severity: 'block', scope: 'turn', count: 4,
      });
    });

    it('resets the warning streak after a success but keeps the per-turn family total', () => {
      for (let i = 0; i < 3; i++) {
        detector.recordToolCall(SESSION, 'run_code', { attempt: i }, `failure-${i}`);
        detector.recordToolOutcome(SESSION, `failure-${i}`, '[TOOL_ERROR code=POLICY] denied');
      }
      detector.recordToolCall(SESSION, 'read_file', { path: 'ok' }, 'success');
      detector.recordToolOutcome(SESSION, 'success', 'verified output');
      expect(detector.detect(SESSION)?.kind).not.toBe('repeated_failure');

      detector.recordToolCall(SESSION, 'run_code', { attempt: 9 }, 'failure-9');
      detector.recordToolOutcome(SESSION, 'failure-9', '[TOOL_ERROR code=POLICY] denied');
      expect(detector.detect(SESSION)).toMatchObject({
        kind: 'repeated_failure', severity: 'block', scope: 'turn', count: 4,
      });
    });

    it('clearSession forgets identical-call blocks so a new turn can retry', () => {
      const args = { action: 'create' };
      for (let i = 0; i < 3; i++) {
        detector.recordToolCall(SESSION, 'notion', args, `n-${i}`);
        detector.recordToolOutcome(SESSION, `n-${i}`, TYPED);
      }
      expect(detector.isCallBlocked(SESSION, 'notion', args)).not.toBeNull();
      detector.clearSession(SESSION);
      expect(detector.isCallBlocked(SESSION, 'notion', args)).toBeNull();
    });
  });

  describe('interactive defaults', () => {
    it('warns at 3 identical no-progress calls, blocks at 5, and breaks at 8', () => {
      const defaults = new ToolLoopDetector();
      const run = (n: number) => {
        for (let i = 0; i < n; i++) {
          defaults.recordToolCall(SESSION, 'web_search', { q: 'same' }, `d-${i}`);
          defaults.recordToolOutcome(SESSION, `d-${i}`, 'same result');
        }
      };
      run(2);
      expect(defaults.detect(SESSION)).toBeNull();
      run(1);
      expect(defaults.detect(SESSION)).toMatchObject({ kind: 'no_progress', severity: 'warning', count: 3 });
      run(2);
      expect(defaults.detect(SESSION)).toMatchObject({ kind: 'no_progress', severity: 'block', count: 5 });
      defaults.clearSession(SESSION);
      run(9);
      expect(defaults.detect(SESSION)).toMatchObject({ kind: 'circuit_breaker', severity: 'block' });
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
