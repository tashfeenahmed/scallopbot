/**
 * LoCoMo Evaluation Tests
 *
 * Runs the LoCoMo benchmark (Maharana et al., ACL 2024) — long-term conversational
 * memory evaluation across 3 modes: OpenClaw, Mem0, ScallopBot.
 *
 * Requires MOONSHOT_API_KEY env var and Ollama running locally.
 * Run: npx vitest run -c /dev/null src/eval/locomo-eval.test.ts
 */

import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  loadLoCoMoData,
  parseLoCoMoDateTime,
  normalizeAnswer,
  computeF1,
  computeEM,
  runLoCoMo,
  printLoCoMoReport,
  type LoCoMoResults,
} from './locomo-eval.js';

const DATA_PATH = path.resolve(process.cwd(), 'data/locomo/locomo10.json');

describe('LoCoMo Evaluation', () => {
  let results: LoCoMoResults;

  it('should load and parse LoCoMo data', () => {
    const conversations = loadLoCoMoData(DATA_PATH);
    expect(conversations).toHaveLength(5);

    // Check selected IDs
    const ids = conversations.map(c => c.sampleId).sort();
    expect(ids).toEqual(['conv-26', 'conv-41', 'conv-42', 'conv-44', 'conv-48']);

    // Total QA should be 1,049
    const totalQA = conversations.reduce((s, c) => s + c.qa.length, 0);
    expect(totalQA).toBe(1049);

    // Each conversation should have sessions and QA
    for (const conv of conversations) {
      expect(conv.sessions.length).toBeGreaterThan(0);
      expect(conv.qa.length).toBeGreaterThan(0);

      // Sessions should have turns
      for (const session of conv.sessions) {
        expect(session.turns.length).toBeGreaterThan(0);
        expect(session.dateTime).toBeInstanceOf(Date);
        expect(session.dateTime.getFullYear()).toBeGreaterThanOrEqual(2022);
        expect(session.dateTime.getFullYear()).toBeLessThanOrEqual(2024);
      }

      // QA items should have required fields
      for (const qa of conv.qa) {
        expect(qa.question).toBeTruthy();
        // Category 5 (adversarial) has null answers — unanswerable by design
        if (qa.category !== 5) {
          expect(qa.answer).toBeTruthy();
        }
        expect(qa.category).toBeGreaterThanOrEqual(1);
        expect(qa.category).toBeLessThanOrEqual(5);
      }
    }

    // Test timestamp parsing
    const dt = parseLoCoMoDateTime('1:56 pm on 8 May, 2023');
    expect(dt.getFullYear()).toBe(2023);
    expect(dt.getMonth()).toBe(4); // May = 4
    expect(dt.getDate()).toBe(8);
    expect(dt.getHours()).toBe(13);
    expect(dt.getMinutes()).toBe(56);

    // Test AM parsing
    const dtAm = parseLoCoMoDateTime('9:30 am on 15 January, 2023');
    expect(dtAm.getHours()).toBe(9);
    expect(dtAm.getMinutes()).toBe(30);

    // Category distribution check
    const catCounts: Record<number, number> = {};
    for (const conv of conversations) {
      for (const qa of conv.qa) {
        catCounts[qa.category] = (catCounts[qa.category] ?? 0) + 1;
      }
    }
    expect(catCounts[1]).toBe(151); // Single-hop
    expect(catCounts[2]).toBe(170); // Temporal
    expect(catCounts[3]).toBe(49);  // Open-domain
    expect(catCounts[4]).toBe(447); // Multi-hop
    expect(catCounts[5]).toBe(232); // Adversarial
  });

  it('should normalize and score QA pairs', () => {
    // Normalization
    expect(normalizeAnswer('The cat')).toEqual(['cat']);
    expect(normalizeAnswer('A big dog')).toEqual(['big', 'dog']);
    expect(normalizeAnswer('running quickly!')).toEqual(['run', 'quick']);

    // F1: perfect match
    expect(computeF1('7 May 2023', '7 May 2023')).toBe(1.0);

    // F1: partial match
    const f1 = computeF1('May 2023', '7 May 2023');
    expect(f1).toBeGreaterThan(0.5);
    expect(f1).toBeLessThan(1.0);

    // F1: no match
    expect(computeF1('something else', '7 May 2023')).toBe(0);

    // F1: UNKNOWN vs real answer
    expect(computeF1('UNKNOWN', 'the answer')).toBe(0);

    // EM: exact match
    expect(computeEM('7 May 2023', '7 May 2023')).toBe(1);

    // EM: different tokens
    expect(computeEM('May 2023', '7 May 2023')).toBe(0);

    // EM: case insensitive
    expect(computeEM('The Cat', 'the cat')).toBe(1);

    // F1 with stemming: "running" and "runs" should both stem
    const f1Stem = computeF1('She was running', 'She runs');
    expect(f1Stem).toBeGreaterThan(0.5);

    // Empty strings
    expect(computeF1('', '')).toBe(1.0);
    expect(computeF1('word', '')).toBe(0);
    expect(computeF1('', 'word')).toBe(0);
  });

  it(
    'should run full LoCoMo benchmark (3 modes)',
    async () => {
      results = await runLoCoMo({
        dataPath: DATA_PATH,
        outputPath: path.resolve(process.cwd(), 'results/locomo-results.json'),
      });

      // Should have results for all 3 modes
      expect(results.modes).toHaveLength(3);
      expect(results.totalQA).toBe(1049);
      expect(results.conversations).toBe(5);

      for (const mode of results.modes) {
        // F1 should be in reasonable range
        expect(mode.overallF1).toBeGreaterThanOrEqual(0);
        expect(mode.overallF1).toBeLessThanOrEqual(1);

        // EM should be in reasonable range
        expect(mode.overallEM).toBeGreaterThanOrEqual(0);
        expect(mode.overallEM).toBeLessThanOrEqual(1);

        // Should have per-category scores
        expect(Object.keys(mode.f1ByCategory).length).toBe(5);

        // Should have per-conversation results
        expect(mode.perConversation).toHaveLength(5);

        // LLM calls should be non-zero
        expect(mode.llmCalls).toBeGreaterThan(0);
      }
    },
    { timeout: 7_200_000 },
  ); // 120 min timeout

  it('should print comparison report', () => {
    if (!results) {
      // Fallback mock results for report rendering test
      results = {
        timestamp: new Date().toISOString(),
        model: 'kimi-k2.5',
        conversations: 5,
        totalQA: 1049,
        modes: [
          {
            mode: 'openclaw', label: 'OpenClaw', overallF1: 0.25, overallEM: 0.10,
            f1ByCategory: { 'Single-hop': 0.35, 'Temporal': 0.20, 'Open-domain': 0.30, 'Multi-hop': 0.22, 'Adversarial': 0.18 },
            emByCategory: { 'Single-hop': 0.15, 'Temporal': 0.08, 'Open-domain': 0.12, 'Multi-hop': 0.09, 'Adversarial': 0.06 },
            perConversation: [
              { sampleId: 'conv-26', f1: 0.24, em: 0.10, qaCount: 199 },
              { sampleId: 'conv-41', f1: 0.26, em: 0.11, qaCount: 200 },
              { sampleId: 'conv-42', f1: 0.25, em: 0.10, qaCount: 210 },
              { sampleId: 'conv-44', f1: 0.23, em: 0.09, qaCount: 220 },
              { sampleId: 'conv-48', f1: 0.27, em: 0.11, qaCount: 220 },
            ],
            llmCalls: 1049, qaCount: 1049,
          },
          {
            mode: 'mem0', label: 'Mem0', overallF1: 0.22, overallEM: 0.08,
            f1ByCategory: { 'Single-hop': 0.30, 'Temporal': 0.18, 'Open-domain': 0.25, 'Multi-hop': 0.20, 'Adversarial': 0.16 },
            emByCategory: { 'Single-hop': 0.12, 'Temporal': 0.06, 'Open-domain': 0.10, 'Multi-hop': 0.07, 'Adversarial': 0.05 },
            perConversation: [
              { sampleId: 'conv-26', f1: 0.21, em: 0.08, qaCount: 199 },
              { sampleId: 'conv-41', f1: 0.23, em: 0.09, qaCount: 200 },
              { sampleId: 'conv-42', f1: 0.22, em: 0.08, qaCount: 210 },
              { sampleId: 'conv-44', f1: 0.20, em: 0.07, qaCount: 220 },
              { sampleId: 'conv-48', f1: 0.24, em: 0.09, qaCount: 220 },
            ],
            llmCalls: 1500, qaCount: 1049,
          },
          {
            mode: 'scallopbot', label: 'ScallopBot', overallF1: 0.30, overallEM: 0.13,
            f1ByCategory: { 'Single-hop': 0.40, 'Temporal': 0.25, 'Open-domain': 0.35, 'Multi-hop': 0.28, 'Adversarial': 0.22 },
            emByCategory: { 'Single-hop': 0.18, 'Temporal': 0.10, 'Open-domain': 0.14, 'Multi-hop': 0.12, 'Adversarial': 0.08 },
            perConversation: [
              { sampleId: 'conv-26', f1: 0.29, em: 0.13, qaCount: 199 },
              { sampleId: 'conv-41', f1: 0.31, em: 0.14, qaCount: 200 },
              { sampleId: 'conv-42', f1: 0.30, em: 0.13, qaCount: 210 },
              { sampleId: 'conv-44', f1: 0.28, em: 0.12, qaCount: 220 },
              { sampleId: 'conv-48', f1: 0.32, em: 0.14, qaCount: 220 },
            ],
            llmCalls: 1600, qaCount: 1049,
          },
        ],
      };
    }

    expect(() => printLoCoMoReport(results)).not.toThrow();
  });
});
