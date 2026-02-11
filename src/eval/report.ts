/**
 * Eval Report Generator
 *
 * Generates comparison tables to stdout and writes pdf/eval-report.md
 * for inclusion in the research paper.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DayMetrics } from './metrics.js';

// ============ Types ============

type MetricsMap = Record<string, DayMetrics[]>;

// ============ Formatting Helpers ============

function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  if (align === 'right') return s.padStart(width);
  return s.padEnd(width);
}

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function pct(a: number, b: number): string {
  if (b === 0) return 'N/A';
  const change = ((a - b) / b) * 100;
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(0)}%`;
}

// ============ Console Table Builder ============

function buildTable(
  headers: string[],
  rows: string[][],
  colWidths: number[],
): string {
  const sep = '+-' + colWidths.map(w => '-'.repeat(w)).join('-+-') + '-+';
  const headerLine = '| ' + headers.map((h, i) => pad(h, colWidths[i])).join(' | ') + ' |';

  const lines = [sep, headerLine, sep];
  for (const row of rows) {
    lines.push('| ' + row.map((c, i) => pad(c, colWidths[i], i === 0 ? 'left' : 'right')).join(' | ') + ' |');
  }
  lines.push(sep);
  return lines.join('\n');
}

// ============ Report Sections ============

function buildPrecisionTable(allMetrics: MetricsMap): string {
  const modes = ['openclaw', 'mem0', 'scallopbot'];
  const labels = ['OpenClaw', 'Mem0', 'ScallopBot'];
  const spotDays = [1, 5, 10, 15, 20, 25, 30];

  const headers = ['Day', ...labels];
  const colWidths = [4, 8, 8, 10];

  const rows: string[][] = [];
  for (const d of spotDays) {
    const row = [d.toString()];
    for (const m of modes) {
      const metrics = allMetrics[m];
      if (metrics && metrics[d - 1]) {
        row.push(fmt(metrics[d - 1].precision5));
      } else {
        row.push('N/A');
      }
    }
    rows.push(row);
  }

  return 'RETRIEVAL PRECISION@5 (higher is better)\n' + buildTable(headers, rows, colWidths);
}

function buildMemoryCountTable(allMetrics: MetricsMap): string {
  const modes = ['openclaw', 'mem0', 'scallopbot'];
  const labels = ['OpenClaw', 'Mem0', 'ScallopBot'];
  const spotDays = [1, 5, 10, 15, 20, 25, 30];

  const headers = ['Day', ...labels];
  const colWidths = [4, 8, 8, 10];

  const rows: string[][] = [];
  for (const d of spotDays) {
    const row = [d.toString()];
    for (const m of modes) {
      const metrics = allMetrics[m];
      if (metrics && metrics[d - 1]) {
        row.push(metrics[d - 1].totalMemories.toString());
      } else {
        row.push('N/A');
      }
    }
    rows.push(row);
  }

  return 'MEMORY COUNT (lower indicates lifecycle management)\n' + buildTable(headers, rows, colWidths);
}

function buildCognitiveTable(allMetrics: MetricsMap): string {
  const modes = ['openclaw', 'mem0', 'scallopbot'];
  const labels = ['OpenClaw', 'Mem0', 'ScallopBot'];

  const headers = ['Metric', ...labels];
  const colWidths = [20, 8, 8, 10];

  const getLastDay = (mode: string): DayMetrics | null => {
    const m = allMetrics[mode];
    return m && m.length > 0 ? m[m.length - 1] : null;
  };

  // Determine the last day number for the title
  const anyMetrics = Object.values(allMetrics).find(m => m && m.length > 0);
  const lastDayNum = anyMetrics ? anyMetrics[anyMetrics.length - 1].day : 0;

  const metricsRows: Array<[string, (m: DayMetrics) => string]> = [
    ['Fusions created', m => m.fusionCount.toString()],
    ['REM discoveries', m => m.remDiscoveries.toString()],
    ['Relations in graph', m => m.relationsCount.toString()],
    ['SOUL words', m => m.soulWords.toString()],
    ['Gap signals', m => m.gapSignals.toString()],
    ['LLM calls (total)', m => m.llmCalls.toString()],
  ];

  const rows: string[][] = [];
  for (const [label, getter] of metricsRows) {
    const row = [label];
    for (const mode of modes) {
      const dLast = getLastDay(mode);
      row.push(dLast ? getter(dLast) : 'N/A');
    }
    rows.push(row);
  }

  return `COGNITIVE FEATURES (Day ${lastDayNum} snapshot)\n` + buildTable(headers, rows, colWidths);
}

function buildImprovementTable(allMetrics: MetricsMap): string {
  const full = allMetrics['scallopbot'];
  if (!full || full.length === 0) return 'IMPROVEMENT SUMMARY: insufficient data\n';

  const lastIdx = full.length - 1;
  const dLastFull = full[lastIdx];
  const lastDayNum = dLastFull.day;

  const comparisons = [
    { name: 'vs OpenClaw', key: 'openclaw' },
    { name: 'vs Mem0', key: 'mem0' },
  ];

  const headers = ['Metric', ...comparisons.map(c => c.name)];
  const colWidths = [20, 12, 12];

  const rows: string[][] = [];

  // Precision@5
  {
    const row = ['Precision@5'];
    for (const comp of comparisons) {
      const other = allMetrics[comp.key];
      if (other && other.length > 0) {
        row.push(pct(dLastFull.precision5, other[other.length - 1].precision5));
      } else {
        row.push('N/A');
      }
    }
    rows.push(row);
  }

  // Memory efficiency (negative is better)
  {
    const row = ['Memory count'];
    for (const comp of comparisons) {
      const other = allMetrics[comp.key];
      if (other && other.length > 0) {
        row.push(pct(dLastFull.totalMemories, other[other.length - 1].totalMemories));
      } else {
        row.push('N/A');
      }
    }
    rows.push(row);
  }

  // MRR
  {
    const row = ['MRR'];
    for (const comp of comparisons) {
      const other = allMetrics[comp.key];
      if (other && other.length > 0) {
        row.push(pct(dLastFull.mrr, other[other.length - 1].mrr));
      } else {
        row.push('N/A');
      }
    }
    rows.push(row);
  }

  return `IMPROVEMENT SUMMARY (ScallopBot vs others, Day ${lastDayNum})\n` + buildTable(headers, rows, colWidths);
}

function buildAffectTable(allMetrics: MetricsMap): string {
  // Use any available mode (all share the same scenario and classifier)
  const metrics = allMetrics['scallopbot'] ?? allMetrics['openclaw'] ?? allMetrics['mem0'];
  if (!metrics || metrics.length === 0) return 'AFFECT CLASSIFICATION: insufficient data\n';

  const headers = ['Day', 'Theme', 'Expected', 'Detected', 'Match'];
  const colWidths = [4, 25, 12, 12, 5];

  // Import SCENARIOS themes lazily via the metrics themselves
  let correct = 0;
  const rows: string[][] = [];
  for (const m of metrics) {
    const match = m.detectedEmotion === m.expectedEmotion;
    if (match) correct++;
    rows.push([
      m.day.toString(),
      '',  // theme not stored in metrics; left blank
      m.expectedEmotion,
      m.detectedEmotion,
      match ? 'Y' : 'N',
    ]);
  }

  const accuracy = metrics.length > 0 ? (correct / metrics.length * 100).toFixed(0) : '0';
  return `AFFECT CLASSIFICATION ACCURACY: ${correct}/${metrics.length} (${accuracy}%)\n` +
    buildTable(headers, rows, colWidths);
}

// ============ Main Report ============

/**
 * Print comparison report to stdout and write pdf/eval-report.md.
 */
export function printComparisonReport(allMetrics: MetricsMap): void {
  const banner = [
    '',
    '='.repeat(70),
    '         30-Day Cognitive Pipeline Benchmark Results',
    '='.repeat(70),
    '',
  ].join('\n');

  const precisionTable = buildPrecisionTable(allMetrics);
  const memoryTable = buildMemoryCountTable(allMetrics);
  const cognitiveTable = buildCognitiveTable(allMetrics);
  const improvementTable = buildImprovementTable(allMetrics);
  const affectTable = buildAffectTable(allMetrics);

  const consoleOutput = [
    banner,
    precisionTable,
    '',
    memoryTable,
    '',
    cognitiveTable,
    '',
    improvementTable,
    '',
    affectTable,
    '',
  ].join('\n');

  console.log(consoleOutput);

  // Write markdown report
  writeMarkdownReport(allMetrics, precisionTable, memoryTable, cognitiveTable, improvementTable, affectTable);

  // Write per-mode JSON data files
  writePerModeData(allMetrics);
}

// ============ Markdown Output ============

function tableToMarkdown(asciiTable: string): string {
  // Convert ASCII table to markdown table
  const lines = asciiTable.split('\n').filter(l => !l.startsWith('+'));
  if (lines.length === 0) return '';

  const mdLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i]
      .split('|')
      .filter(c => c.trim().length > 0)
      .map(c => c.trim());

    mdLines.push('| ' + cells.join(' | ') + ' |');
    if (i === 0) {
      // Header separator
      mdLines.push('| ' + cells.map(c => '-'.repeat(Math.max(3, c.length))).join(' | ') + ' |');
    }
  }
  return mdLines.join('\n');
}

function writeMarkdownReport(
  allMetrics: MetricsMap,
  precisionTable: string,
  memoryTable: string,
  cognitiveTable: string,
  improvementTable: string,
  affectTable: string,
): void {
  const sections = [
    '# 30-Day Cognitive Pipeline Benchmark Results',
    '',
    `**Generated**: ${new Date().toISOString()}`,
    '',
    '**Providers**:',
    '- Embeddings: Ollama `nomic-embed-text` (768-dim, local)',
    '- LLM: Moonshot `kimi-k2.5` (API)',
    '',
    '## Retrieval Precision@5',
    '',
    tableToMarkdown(precisionTable.split('\n').slice(1).join('\n')),
    '',
    '## Memory Count',
    '',
    tableToMarkdown(memoryTable.split('\n').slice(1).join('\n')),
    '',
    '## Cognitive Features (Final Day)',
    '',
    tableToMarkdown(cognitiveTable.split('\n').slice(1).join('\n')),
    '',
    '## Improvement Summary',
    '',
    tableToMarkdown(improvementTable.split('\n').slice(1).join('\n')),
    '',
    '## Affect Classification Accuracy',
    '',
    tableToMarkdown(affectTable.split('\n').slice(1).join('\n')),
    '',
    '## Daily Metrics (Full)',
    '',
  ];

  // Full daily metrics for each mode
  const modes = ['openclaw', 'mem0', 'scallopbot'];
  for (const mode of modes) {
    const metrics = allMetrics[mode];
    if (!metrics) continue;

    sections.push(`### ${mode}`);
    sections.push('');
    sections.push('| Day | Memories | Active | Dormant | P@5 | Recall | MRR | Fusions | Relations | LLM Calls |');
    sections.push('| --- | -------- | ------ | ------- | --- | ------ | --- | ------- | --------- | --------- |');

    for (const m of metrics) {
      sections.push(
        `| ${m.day} | ${m.totalMemories} | ${m.activeCount} | ${m.dormantCount} | ${fmt(m.precision5)} | ${fmt(m.recall)} | ${fmt(m.mrr)} | ${m.fusionCount} | ${m.relationsCount} | ${m.llmCalls} |`
      );
    }
    sections.push('');
  }

  const markdown = sections.join('\n');

  // Ensure pdf/ directory exists
  const pdfDir = path.resolve(process.cwd(), 'pdf');
  try { fs.mkdirSync(pdfDir, { recursive: true }); } catch { /* exists */ }

  const reportPath = path.join(pdfDir, 'eval-report.md');
  fs.writeFileSync(reportPath, markdown, 'utf-8');
  console.log(`\nMarkdown report written to: ${reportPath}`);
}

// ============ Per-Mode JSON Export ============

/**
 * Write raw DayMetrics[] as JSON for each mode.
 * Produces: pdf/eval-data-openclaw.json, pdf/eval-data-mem0.json, pdf/eval-data-scallopbot.json
 */
function writePerModeData(allMetrics: MetricsMap): void {
  const pdfDir = path.resolve(process.cwd(), 'pdf');
  try { fs.mkdirSync(pdfDir, { recursive: true }); } catch { /* exists */ }

  for (const mode of ['openclaw', 'mem0', 'scallopbot']) {
    const metrics = allMetrics[mode];
    if (!metrics) continue;

    const filePath = path.join(pdfDir, `eval-data-${mode}.json`);
    fs.writeFileSync(filePath, JSON.stringify(metrics, null, 2), 'utf-8');
    console.log(`Per-mode data written to: ${filePath}`);
  }
}
