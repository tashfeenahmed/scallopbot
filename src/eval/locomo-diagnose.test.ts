/**
 * Diagnostic: Why is ScallopBot retrieval weak on LoCoMo?
 *
 * Ingests conv-44 for both OpenClaw and ScallopBot, then compares:
 * 1. Memory store stats (total, active, dormant, archived)
 * 2. Search results for 10 sample QA questions
 * 3. LLM answers given different retrieved contexts
 * 4. Impact of reranking vs raw search
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { ScallopMemoryStore } from '../memory/scallop-store.js';
import { BackgroundGardener } from '../memory/memory.js';
import { testLogger } from '../e2e/helpers.js';
import {
  createEvalProviders,
  categorizeMessage,
  estimateImportance,
} from './eval-runner.js';
import { createModeSearch, OPENCLAW_MODE, SCALLOPBOT_MODE } from './modes.js';
import { loadLoCoMoData, computeF1 } from './locomo-eval.js';
import type { LLMProvider, ContentBlock } from '../providers/types.js';

const DATA_PATH = path.resolve(process.cwd(), 'data/locomo/locomo10.json');

function extractText(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map(b => b.text)
    .join('');
}

describe('LoCoMo ScallopBot Diagnosis', () => {
  it(
    'should compare OpenClaw vs ScallopBot retrieval on conv-44',
    async () => {
      const conversations = loadLoCoMoData(DATA_PATH, new Set(['conv-44']));
      const conv = conversations[0];
      const { embedder, llmProvider } = createEvalProviders();

      // Pick 10 sample QA items across categories (skip adversarial)
      const sampleQA = [
        ...conv.qa.filter(q => q.category === 1).slice(0, 2), // single-hop
        ...conv.qa.filter(q => q.category === 2).slice(0, 2), // temporal
        ...conv.qa.filter(q => q.category === 3).slice(0, 2), // open-domain
        ...conv.qa.filter(q => q.category === 4).slice(0, 4), // multi-hop
      ];

      console.log(`\nDiagnosing with ${sampleQA.length} QA items from conv-44\n`);

      // ─── Ingest for BOTH modes ───
      const stores: Record<string, { store: ScallopMemoryStore; dbPath: string }> = {};

      for (const mode of [OPENCLAW_MODE, SCALLOPBOT_MODE]) {
        const dbPath = `/tmp/locomo-diag-${mode.name}-${Date.now()}.db`;
        const store = new ScallopMemoryStore({
          dbPath,
          logger: testLogger,
          embedder,
          decayConfig: mode.enableDecay ? mode.decayOverrides : { baseDecayRate: 1.0 },
          rerankProvider: mode.enableReranking ? llmProvider : undefined,
        });

        const db = store.getDatabase();
        const gardener = new BackgroundGardener({
          scallopStore: store,
          logger: testLogger,
          fusionProvider: (mode.enableFusion || mode.enableDreams || mode.enableReflection)
            ? llmProvider
            : undefined,
          quietHours: { start: 2, end: 5 },
        });

        let lastDay = -1;

        for (const session of conv.sessions) {
          vi.setSystemTime(session.dateTime);
          const currentDay = session.dateTime.getDate();
          const dayChanged = currentDay !== lastDay && lastDay !== -1;

          if (dayChanged && mode.enableDecay) {
            gardener.lightTick();
          }
          if (dayChanged && mode.enableFusion) {
            await gardener.deepTick();
          }
          if (dayChanged && (mode.enableDreams || mode.enableReflection)) {
            const sleepTime = new Date(session.dateTime);
            sleepTime.setHours(3, 0, 0, 0);
            vi.setSystemTime(sleepTime);
            await gardener.sleepTick();
            vi.setSystemTime(session.dateTime);
          }

          lastDay = currentDay;

          for (const turn of session.turns) {
            const content = `${turn.speaker}: ${turn.text}`;
            await store.add({
              userId: 'default',
              content,
              category: categorizeMessage(content),
              importance: estimateImportance(content),
              source: 'user',
              detectRelations: mode.enableFusion || mode.enableDreams,
            });
          }
        }

        // Final ticks
        if (mode.enableDecay) gardener.lightTick();
        if (mode.enableFusion) await gardener.deepTick();
        if (mode.enableDreams || mode.enableReflection) {
          const lastDate = conv.sessions[conv.sessions.length - 1].dateTime;
          const sleepTime = new Date(lastDate);
          sleepTime.setDate(sleepTime.getDate() + 1);
          sleepTime.setHours(3, 0, 0, 0);
          vi.setSystemTime(sleepTime);
          await gardener.sleepTick();
        }

        stores[mode.name] = { store, dbPath };
      }

      // ─── Diagnosis 1: Memory store stats ───
      console.log('\n' + '='.repeat(60));
      console.log('  DIAGNOSIS 1: Memory Store Stats');
      console.log('='.repeat(60));

      for (const [name, { store }] of Object.entries(stores)) {
        const stats = store.getStats();
        const db = store.getDatabase();
        const allMems = db.getMemoriesByUser('default', { isLatest: true, includeAllSources: true });
        const withEmb = allMems.filter(m => m.embedding != null).length;
        const archived = allMems.filter(m => m.prominence != null && m.prominence < 0.01).length;
        const dormant = allMems.filter(m => m.prominence != null && m.prominence >= 0.01 && m.prominence < 0.3).length;
        const active = allMems.filter(m => m.prominence == null || m.prominence >= 0.3).length;
        const deleted = allMems.filter(m => m.content === '[DELETED]').length;
        const fused = allMems.filter(m => m.source === 'derived').length;

        console.log(`\n${name.toUpperCase()}:`);
        console.log(`  Total memories:  ${allMems.length}`);
        console.log(`  With embeddings: ${withEmb}`);
        console.log(`  Active (p>=0.3): ${active}`);
        console.log(`  Dormant (p<0.3): ${dormant}`);
        console.log(`  Archived (p<0.01): ${archived}`);
        console.log(`  Deleted:         ${deleted}`);
        console.log(`  Fused/derived:   ${fused}`);
        console.log(`  Stats:           ${JSON.stringify(stats)}`);
      }

      // ─── Diagnosis 2: Search comparison for sample questions ───
      console.log('\n' + '='.repeat(60));
      console.log('  DIAGNOSIS 2: Search Results Comparison');
      console.log('='.repeat(60));

      const ocStore = stores['openclaw'];
      const sbStore = stores['scallopbot'];
      const ocDb = ocStore.store.getDatabase();
      const sbDb = sbStore.store.getDatabase();
      const ocSearch = createModeSearch(OPENCLAW_MODE, ocStore.store, ocDb, embedder);
      const sbSearch = createModeSearch(SCALLOPBOT_MODE, sbStore.store, sbDb, embedder);

      // Also create a ScallopBot search WITHOUT reranking for comparison
      const sbStoreNoRerank = new ScallopMemoryStore({
        dbPath: stores['scallopbot'].dbPath, // same DB, no reranker
        logger: testLogger,
        embedder,
        decayConfig: SCALLOPBOT_MODE.decayOverrides,
        // NO rerankProvider
      });
      const sbDbNoRerank = sbStoreNoRerank.getDatabase();
      const sbSearchNoRerank = createModeSearch(
        { ...SCALLOPBOT_MODE, enableReranking: false },
        sbStoreNoRerank,
        sbDbNoRerank,
        embedder,
      );

      for (const qa of sampleQA) {
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`Q (cat ${qa.category}): ${qa.question}`);
        console.log(`A: ${qa.answer}`);

        const ocResults = await ocSearch(qa.question, 5);
        const sbResults = await sbSearch(qa.question, 5);
        const sbNoRerankResults = await sbSearchNoRerank(qa.question, 5);

        console.log(`\n  OpenClaw (${ocResults.length} results):`);
        for (const r of ocResults) {
          const snippet = r.memory.content.slice(0, 100);
          console.log(`    [${r.score.toFixed(3)}] ${snippet}...`);
        }

        console.log(`\n  ScallopBot (${sbResults.length} results):`);
        for (const r of sbResults) {
          const snippet = r.memory.content.slice(0, 100);
          const prom = r.memory.prominence?.toFixed(3) ?? 'null';
          console.log(`    [${r.score.toFixed(3)} p=${prom}] ${snippet}...`);
        }

        console.log(`\n  ScallopBot NO rerank (${sbNoRerankResults.length} results):`);
        for (const r of sbNoRerankResults) {
          const snippet = r.memory.content.slice(0, 100);
          const prom = r.memory.prominence?.toFixed(3) ?? 'null';
          console.log(`    [${r.score.toFixed(3)} p=${prom}] ${snippet}...`);
        }

        // Check if the answer text appears in any retrieved memory
        const answerLower = qa.answer.toLowerCase();
        const ocHasAnswer = ocResults.some(r => r.memory.content.toLowerCase().includes(answerLower));
        const sbHasAnswer = sbResults.some(r => r.memory.content.toLowerCase().includes(answerLower));
        const sbNRHasAnswer = sbNoRerankResults.some(r => r.memory.content.toLowerCase().includes(answerLower));
        console.log(`\n  Answer in context? OC=${ocHasAnswer} SB=${sbHasAnswer} SB-noRerank=${sbNRHasAnswer}`);
      }

      // ─── Diagnosis 3: Aggregate retrieval hit rate ───
      console.log('\n' + '='.repeat(60));
      console.log('  DIAGNOSIS 3: Retrieval Hit Rate (answer in top-5)');
      console.log('='.repeat(60));

      let ocHits = 0, sbHits = 0, sbNRHits = 0;
      const nonAdv = conv.qa.filter(q => q.category !== 5 && q.answer);
      const checkCount = Math.min(nonAdv.length, 50); // check first 50

      for (let i = 0; i < checkCount; i++) {
        const qa = nonAdv[i];
        const ansLower = qa.answer.toLowerCase();

        const ocR = await ocSearch(qa.question, 5);
        const sbR = await sbSearch(qa.question, 5);
        const sbNRR = await sbSearchNoRerank(qa.question, 5);

        if (ocR.some(r => r.memory.content.toLowerCase().includes(ansLower))) ocHits++;
        if (sbR.some(r => r.memory.content.toLowerCase().includes(ansLower))) sbHits++;
        if (sbNRR.some(r => r.memory.content.toLowerCase().includes(ansLower))) sbNRHits++;
      }

      console.log(`\nChecked ${checkCount} non-adversarial QA items:`);
      console.log(`  OpenClaw hit rate:              ${ocHits}/${checkCount} = ${(ocHits/checkCount*100).toFixed(1)}%`);
      console.log(`  ScallopBot hit rate:            ${sbHits}/${checkCount} = ${(sbHits/checkCount*100).toFixed(1)}%`);
      console.log(`  ScallopBot (no rerank) hit rate: ${sbNRHits}/${checkCount} = ${(sbNRHits/checkCount*100).toFixed(1)}%`);

      // ─── Diagnosis 4: Prominence distribution ───
      console.log('\n' + '='.repeat(60));
      console.log('  DIAGNOSIS 4: ScallopBot Prominence Distribution');
      console.log('='.repeat(60));

      const sbMems = sbDb.getMemoriesByUser('default', { isLatest: true, includeAllSources: true });
      const promBuckets = { 'p>=0.8': 0, '0.5<=p<0.8': 0, '0.3<=p<0.5': 0, '0.1<=p<0.3': 0, 'p<0.1': 0 };
      for (const m of sbMems) {
        const p = m.prominence ?? 1.0;
        if (p >= 0.8) promBuckets['p>=0.8']++;
        else if (p >= 0.5) promBuckets['0.5<=p<0.8']++;
        else if (p >= 0.3) promBuckets['0.3<=p<0.5']++;
        else if (p >= 0.1) promBuckets['0.1<=p<0.3']++;
        else promBuckets['p<0.1']++;
      }
      console.log(`  Total: ${sbMems.length}`);
      for (const [bucket, count] of Object.entries(promBuckets)) {
        const bar = '█'.repeat(Math.round(count / sbMems.length * 40));
        console.log(`  ${bucket.padEnd(14)} ${String(count).padStart(4)}  ${bar}`);
      }

      // Cleanup
      for (const { store, dbPath } of Object.values(stores)) {
        store.close();
        try {
          for (const suffix of ['', '-wal', '-shm']) fs.unlinkSync(dbPath + suffix);
        } catch { /* ignore */ }
      }
      sbStoreNoRerank.close();

      expect(true).toBe(true); // diagnostic always passes
    },
    { timeout: 1_800_000 },
  ); // 30 min
});
