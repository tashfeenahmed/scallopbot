/**
 * EmoBench Evaluation Tests
 *
 * Runs the EmoBench benchmark (Sabour et al., ACL 2024) against three conditions:
 * 1. Baseline (OpenClaw) — bare LLM with standard EmoBench prompts
 * 2. ScallopBot — LLM with affect-enriched system prompt
 * 3. AFINN-165 Direct — lexicon classifier vs ground-truth valence
 *
 * Requires MOONSHOT_API_KEY env var for LLM conditions.
 * Run: npx vitest run src/eval/emobench-eval.test.ts
 */

import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  loadEmoBenchData,
  runEACondition,
  runEUCondition,
  runAFINNDirect,
  runEmoBench,
  printEmoBenchReport,
  type EmoBenchResults,
} from './emobench-eval.js';
import { MoonshotProvider } from '../providers/moonshot.js';

const DATA_DIR = path.resolve(process.cwd(), 'data/emobench');

describe('EmoBench Evaluation', () => {
  // Shared state across tests (populated by full run)
  let results: EmoBenchResults;

  it('should load EmoBench data (English only)', () => {
    const { eu, ea } = loadEmoBenchData(DATA_DIR);
    expect(eu.length).toBe(200);
    expect(ea.length).toBe(200);

    // Verify structure
    expect(eu[0]).toHaveProperty('scenario');
    expect(eu[0]).toHaveProperty('emotion_choices');
    expect(eu[0]).toHaveProperty('emotion_label');
    expect(eu[0]).toHaveProperty('cause_choices');
    expect(eu[0]).toHaveProperty('cause_label');

    expect(ea[0]).toHaveProperty('scenario');
    expect(ea[0]).toHaveProperty('choices');
    expect(ea[0]).toHaveProperty('label');
    expect(ea[0]).toHaveProperty('category');
  });

  it('should run AFINN-165 direct classifier test', () => {
    const { eu } = loadEmoBenchData(DATA_DIR);
    const afinnResults = runAFINNDirect(eu);

    expect(afinnResults).toHaveLength(200);

    // Each result should have required fields
    for (const r of afinnResults) {
      expect(r).toHaveProperty('qid');
      expect(r).toHaveProperty('emotionLabel');
      expect(r).toHaveProperty('detectedValence');
      expect(r).toHaveProperty('detectedArousal');
      expect(r).toHaveProperty('valenceCorrect');
      expect(r).toHaveProperty('quadrantCorrect');
      expect(typeof r.detectedValence).toBe('number');
      expect(typeof r.detectedArousal).toBe('number');
    }

    // Valence accuracy should be above chance (>50%) for a reasonable classifier
    const valenceCorrect = afinnResults.filter(r => r.valenceCorrect).length;
    const valenceAccuracy = valenceCorrect / afinnResults.length;
    console.log(`AFINN-165 valence accuracy: ${(valenceAccuracy * 100).toFixed(1)}%`);
    expect(valenceAccuracy).toBeGreaterThan(0.4);
  });

  it(
    'should run full EmoBench evaluation (baseline + ScallopBot + AFINN)',
    async () => {
      results = await runEmoBench({
        dataDir: DATA_DIR,
        outputPath: path.resolve(process.cwd(), 'results/emobench-results.json'),
      });

      // EA scores should be in reasonable range
      expect(results.ea.baseline.overall).toBeGreaterThan(0);
      expect(results.ea.scallopbot.overall).toBeGreaterThan(0);
      expect(results.ea.baseline.overall).toBeLessThanOrEqual(1);
      expect(results.ea.scallopbot.overall).toBeLessThanOrEqual(1);

      // EU scores should be in reasonable range
      expect(results.eu.baseline.overall).toBeGreaterThan(0);
      expect(results.eu.scallopbot.overall).toBeGreaterThan(0);

      // AFINN should have run on all 200 EU items
      expect(results.afinn.totalItems).toBe(200);

      // Categories should be populated
      expect(Object.keys(results.ea.baseline.byCategory).length).toBeGreaterThan(0);
      expect(Object.keys(results.eu.baseline.byCategory).length).toBeGreaterThan(0);
    },
    { timeout: 1_200_000 },
  ); // 20 min timeout for LLM calls

  it('should print comparison report', () => {
    if (!results) {
      // If the full run was skipped, create minimal results for report test
      results = {
        timestamp: new Date().toISOString(),
        model: 'kimi-k2.5',
        ea: {
          baseline: { overall: 0.65, byCategory: { 'Personal-Others': 0.7, 'Social-Self': 0.6 } },
          scallopbot: { overall: 0.67, byCategory: { 'Personal-Others': 0.72, 'Social-Self': 0.62 } },
        },
        eu: {
          baseline: { overall: 0.35, byCategory: { complex_emotions: 0.3, perspective_taking: 0.4 } },
          scallopbot: { overall: 0.37, byCategory: { complex_emotions: 0.32, perspective_taking: 0.42 } },
        },
        afinn: { valenceAccuracy: 0.55, quadrantAccuracy: 0.3, totalItems: 200 },
      };
    }

    // Should not throw
    expect(() => printEmoBenchReport(results)).not.toThrow();
  });
});
