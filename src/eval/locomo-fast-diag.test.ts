/**
 * Fast diagnostic: compare memory counts and retrieval hit rates
 * with dedup threshold at 0.93 (raised from 0.82).
 *
 * Skips LLM reranking and cognitive ticks — just tests raw ingestion + search.
 * Run: npx vitest run -c /dev/null src/eval/locomo-fast-diag.test.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { ScallopMemoryStore } from '../memory/scallop-store.js';
import { testLogger } from '../e2e/helpers.js';
import { OllamaEmbedder, cosineSimilarity } from '../memory/embeddings.js';
import {
  categorizeMessage,
  estimateImportance,
} from './eval-runner.js';
import { loadLoCoMoData, computeF1, scoreAdversarial } from './locomo-eval.js';

const DATA_PATH = path.resolve(process.cwd(), 'data/locomo/locomo10.json');

describe('Fast dedup threshold diagnostic', () => {
  it(
    'should compare OpenClaw-style vs ScallopBot ingestion + raw search',
    async () => {
      const conversations = loadLoCoMoData(DATA_PATH, new Set(['conv-44']));
      const conv = conversations[0];

      const embedder = new OllamaEmbedder({
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
      });

      // ── Ingest for both modes (no LLM, no reranker, no cognitive ticks) ──
      const results: Record<string, {
        store: ScallopMemoryStore;
        dbPath: string;
        memCount: number;
      }> = {};

      for (const mode of ['openclaw', 'scallopbot'] as const) {
        const dbPath = `/tmp/locomo-fdiag-${mode}-${Date.now()}.db`;
        const store = new ScallopMemoryStore({
          dbPath,
          logger: testLogger,
          embedder,
          // OpenClaw: no decay; ScallopBot: decay config but we skip ticks
          decayConfig: mode === 'openclaw' ? { baseDecayRate: 1.0 } : undefined,
          // NO rerankProvider for either — raw search only
        });

        for (const session of conv.sessions) {
          vi.setSystemTime(session.dateTime);
          for (const turn of session.turns) {
            const content = `${turn.speaker}: ${turn.text}`;
            await store.add({
              userId: 'default',
              content,
              category: categorizeMessage(content),
              importance: estimateImportance(content),
              source: 'user',
              detectRelations: false,
            });
          }
        }

        const db = store.getDatabase();
        const allMems = db.getMemoriesByUser('default', {
          isLatest: true,
          includeAllSources: true,
        });
        results[mode] = { store, dbPath, memCount: allMems.length };
      }

      console.log('\n' + '='.repeat(60));
      console.log('  MEMORY COUNTS (dedup threshold = 0.93)');
      console.log('='.repeat(60));
      console.log(`  OpenClaw (no dedup):    ${results['openclaw'].memCount} memories`);
      console.log(`  ScallopBot (0.93 dedup): ${results['scallopbot'].memCount} memories`);
      console.log(`  Retention rate: ${(results['scallopbot'].memCount / results['openclaw'].memCount * 100).toFixed(1)}%`);
      console.log(`  (Previous @ 0.82: 19/427 = 4.4%)`);

      // ── Retrieval hit rate: raw cosine search, no reranker ──
      const nonAdv = conv.qa.filter(q => q.category !== 5 && q.answer);

      async function rawSearch(store: ScallopMemoryStore, query: string, limit: number) {
        const db = store.getDatabase();
        const candidates = db.getMemoriesByUser('default', {
          isLatest: true,
          includeAllSources: true,
        });
        const qEmb = await embedder.embed(query);
        return candidates
          .filter(m => m.embedding != null)
          .map(m => ({ memory: m, score: cosineSimilarity(qEmb, m.embedding!) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      }

      let ocHits = 0, sbHits = 0;
      for (const qa of nonAdv) {
        const ansLower = qa.answer.toLowerCase();

        const ocR = await rawSearch(results['openclaw'].store, qa.question, 5);
        const sbR = await rawSearch(results['scallopbot'].store, qa.question, 5);

        if (ocR.some(r => r.memory.content.toLowerCase().includes(ansLower))) ocHits++;
        if (sbR.some(r => r.memory.content.toLowerCase().includes(ansLower))) sbHits++;
      }

      console.log('\n' + '='.repeat(60));
      console.log('  RETRIEVAL HIT RATE (answer in top-5, raw cosine)');
      console.log('='.repeat(60));
      console.log(`  Checked: ${nonAdv.length} non-adversarial QA items`);
      console.log(`  OpenClaw:              ${ocHits}/${nonAdv.length} = ${(ocHits / nonAdv.length * 100).toFixed(1)}%`);
      console.log(`  ScallopBot (0.93):     ${sbHits}/${nonAdv.length} = ${(sbHits / nonAdv.length * 100).toFixed(1)}%`);
      console.log(`  (Previous SB @ 0.82:   5/50 = 10.0%  — partial check)`);
      console.log(`  (Previous OC @ 0.82:   7/50 = 14.0%  — partial check)`);

      // ── Quick F1 comparison: answer 20 QA items with each mode's context ──
      console.log('\n' + '='.repeat(60));
      console.log('  QUICK F1 (20 QA, no LLM — just check if answer tokens in context)');
      console.log('='.repeat(60));

      const sample20 = nonAdv.slice(0, 20);
      let ocF1Sum = 0, sbF1Sum = 0;
      for (const qa of sample20) {
        const ocR = await rawSearch(results['openclaw'].store, qa.question, 5);
        const sbR = await rawSearch(results['scallopbot'].store, qa.question, 5);

        const ocContext = ocR.map(r => r.memory.content).join(' ').toLowerCase();
        const sbContext = sbR.map(r => r.memory.content).join(' ').toLowerCase();

        // Proxy F1: how many answer tokens appear in context
        const ansTokens = qa.answer.toLowerCase().split(/\s+/).filter(t => t.length > 2);
        const ocMatches = ansTokens.filter(t => ocContext.includes(t)).length;
        const sbMatches = ansTokens.filter(t => sbContext.includes(t)).length;
        const ocProxy = ansTokens.length > 0 ? ocMatches / ansTokens.length : 0;
        const sbProxy = ansTokens.length > 0 ? sbMatches / ansTokens.length : 0;
        ocF1Sum += ocProxy;
        sbF1Sum += sbProxy;
      }

      console.log(`  OpenClaw proxy F1:      ${(ocF1Sum / sample20.length).toFixed(3)}`);
      console.log(`  ScallopBot proxy F1:    ${(sbF1Sum / sample20.length).toFixed(3)}`);

      // Cleanup
      for (const { store, dbPath } of Object.values(results)) {
        store.close();
        try {
          for (const suffix of ['', '-wal', '-shm']) fs.unlinkSync(dbPath + suffix);
        } catch { /* ignore */ }
      }

      // ScallopBot should retain significantly more memories at 0.93
      expect(results['scallopbot'].memCount).toBeGreaterThan(100);
    },
    { timeout: 600_000 },
  ); // 10 min
});
