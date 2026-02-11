/**
 * Smart Mock LLM Provider for Cognitive Operations
 *
 * Pattern-matching mock that detects operation type from the system/user
 * prompt and returns appropriate structured responses. Designed for the
 * eval framework where real LLM calls would be too slow and expensive.
 *
 * Detection rules (checked in order against combined system + user prompt):
 * 1. Contains "fuse"/"consolidate"/"merge" → fusion response JSON
 * 2. Contains "NREM" → NREM consolidation response
 * 3. Contains "novelty" + "plausibility" → REM judge scores
 * 4. Contains "reflection" + "insights" → reflection insights JSON
 * 5. Contains "SOUL" + "guidelines" → markdown personality snapshot
 * 6. Contains "diagnose" + "gap" → gap diagnosis JSON
 * 7. Contains "inner" + "proactive" → inner thoughts decision JSON
 * 8. Contains "summarize" → session summary text
 * 9. Contains "re-rank"/"relevance" → reranking scores JSON
 * 10. Default → generic text response
 */

import type { LLMProvider, CompletionRequest, CompletionResponse, ContentBlock } from '../providers/types.js';

// ============ Types ============

export interface CognitiveCallLogEntry {
  operation: string;
  timestamp: number;
}

export type CognitiveMockProvider = LLMProvider & {
  callLog: CognitiveCallLogEntry[];
  callCount: number;
};

// ============ Keyword extraction ============

/**
 * Extract key content words from a text block for contextual responses.
 */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
    'not', 'no', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'each',
    'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such',
    'than', 'too', 'very', 'just', 'also', 'now', 'only', 'then', 'that',
    'this', 'these', 'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our',
    'you', 'your', 'he', 'she', 'they', 'them', 'their', 'what', 'which',
    'who', 'whom', 'how', 'when', 'where', 'why', 'if', 'about', 'up',
    'out', 'down', 'over', 'under', 'again', 'here', 'there', 'once',
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

// ============ Response generators ============

function fusionResponse(prompt: string): string {
  const importantTerms = ['sushi', 'postgresql', 'postgres', 'alice', 'bob', 'atlas',
    'running', '5k', 'japan', 'kyoto', 'hiking', 'cooking', 'february', 'feb 25',
    'rust', 'microservices', 'favorite', 'deadline', 'sourdough', 'pasta'];
  const sentences = prompt.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const relevantSentences = sentences.filter(s =>
    importantTerms.some(term => s.toLowerCase().includes(term))
  ).slice(0, 3);

  const summary = relevantSentences.length > 0
    ? relevantSentences.map(s => s.trim()).join('. ') + '.'
    : 'Consolidated related memories.';
  return JSON.stringify({
    summary,
    importance: 8,
    category: 'fact',
    confidence: 0.85,
  });
}

function nremResponse(prompt: string): string {
  const importantTerms = ['sushi', 'postgresql', 'postgres', 'alice', 'bob', 'atlas',
    'running', '5k', 'japan', 'kyoto', 'hiking', 'cooking', 'february', 'feb 25',
    'rust', 'microservices', 'favorite', 'deadline', 'sourdough', 'pasta'];
  const sentences = prompt.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const relevantSentences = sentences.filter(s =>
    importantTerms.some(term => s.toLowerCase().includes(term))
  ).slice(0, 3);

  const summary = relevantSentences.length > 0
    ? relevantSentences.map(s => s.trim()).join('. ') + '.'
    : 'NREM consolidation: merged related memory cluster.';
  return JSON.stringify({
    summary,
    importance: 8,
    category: 'fact',
    confidence: 0.85,
  });
}

function remJudgeResponse(): string {
  return JSON.stringify({
    novelty: 4,
    plausibility: 3,
    connection: 'These memories share a thematic connection through the user\'s goals and activities.',
  });
}

function reflectionResponse(prompt: string): string {
  const keywords = extractKeywords(prompt).slice(0, 8);
  const topics = keywords.slice(0, 3);
  return JSON.stringify({
    insights: [
      {
        content: `The user shows strong engagement with ${topics[0] ?? 'technical'} topics and values ${topics[1] ?? 'personal'} growth.`,
        topics: topics.length > 0 ? topics : ['general'],
      },
      {
        content: `Pattern: user alternates between focused work periods and personal interest exploration.`,
        topics: ['work-life', 'patterns'],
      },
    ],
    principles: [
      'Be supportive during stressful work periods',
      'Remember and reference personal goals proactively',
      'Celebrate achievements and milestones',
    ],
  });
}

function soulResponse(): string {
  return [
    '# SOUL — ScallopBot Personality Guidelines',
    '',
    '## Core Identity',
    'I am a supportive assistant who remembers personal context and adapts communication style.',
    '',
    '## Communication Principles',
    '- Be encouraging during stressful periods while remaining honest',
    '- Reference previous conversations naturally to build continuity',
    '- Balance professional advice with personal warmth',
    '- Celebrate achievements and milestones proactively',
    '',
    '## Behavioral Patterns Observed',
    '- User values work-life balance but tends to over-commit during deadlines',
    '- Personal hobbies (cooking, hiking) serve as stress relief',
    '- Goal-setting is aspirational but follow-through needs gentle nudging',
    '- Technical discussions are most engaging when architecture-focused',
    '',
    '## Engagement Guidelines',
    '- Check in on stated goals (running, learning Rust) if not mentioned recently',
    '- Connect new topics to known interests when natural',
    '- Provide actionable advice rather than generic encouragement',
    '- Respect the user\'s emotional state and adjust tone accordingly',
    '',
    '## Known Preferences',
    '- Favorite food: sushi (salmon nigiri)',
    '- Favorite color: blue',
    '- Hobbies: cooking, hiking, running (new)',
    '- Professional: backend engineering, interested in Rust',
    '- Travel: Japan trip planned for April',
  ].join('\n');
}

function gapDiagnosisResponse(prompt: string): string {
  const keywords = extractKeywords(prompt);
  const hasRunning = keywords.some(k => k.includes('run') || k.includes('5k') || k.includes('exercise'));
  return JSON.stringify({
    gaps: [
      {
        signal: hasRunning ? 'stale_goal' : 'behavioral_anomaly',
        diagnosis: hasRunning
          ? 'User has not followed up on running goal. The 5K deadline is approaching with minimal training.'
          : 'Detected engagement pattern shift worth monitoring.',
        urgency: hasRunning ? 'medium' : 'low',
        suggestedAction: hasRunning
          ? 'Gently check in on running progress and offer encouragement.'
          : 'Continue monitoring for sustained pattern change.',
      },
    ],
  });
}

function innerThoughtsResponse(): string {
  return JSON.stringify({
    decision: 'proact',
    reason: 'User has a pending goal (running/5K) that has not been mentioned recently.',
    message: 'Hey! I noticed you mentioned wanting to run 3x/week for your 5K. How\'s the training going? Want to set up a schedule?',
    urgency: 'medium',
  });
}

function summarizeResponse(prompt: string): string {
  const keywords = extractKeywords(prompt).slice(0, 5);
  return keywords.length > 0
    ? `Session covered: ${keywords.join(', ')}. User engaged in detailed discussion.`
    : 'Brief session with general discussion.';
}

function rerankResponse(prompt: string): string {
  // Parse how many results to re-rank from the prompt
  const countMatch = prompt.match(/(\d+)\s*(?:results|memories|items)/i);
  const count = countMatch ? Math.min(parseInt(countMatch[1], 10), 10) : 5;
  const scores = Array.from({ length: count }, (_, i) => ({
    index: i,
    score: Math.max(0.1, 1.0 - i * 0.15 + (Math.sin(i * 2.1) * 0.05)),
  }));
  return JSON.stringify(scores);
}

// ============ Operation detection ============

/**
 * Detect cognitive operation from prompt text.
 *
 * Uses the **system prompt** as the primary signal (we control it — no
 * false positives from user-generated content).  Falls back to the
 * combined text for operations where the system prompt alone isn't enough.
 */
function detectOperation(systemPrompt: string, userPrompt: string): string {
  const sys = systemPrompt.toLowerCase();
  const combined = `${systemPrompt} ${userPrompt}`.toLowerCase();

  // ── System-prompt-based detection (most reliable) ──
  // NREM consolidation — system says "NREM" or "deep sleep consolidation"
  if (sys.includes('nrem') || (sys.includes('deep sleep') && sys.includes('consolidat'))) return 'nrem';
  // Fusion — system says "fuse" / "consolidate" / "merge" (as standalone module)
  if (sys.includes('fuse') || sys.includes('fusion') || sys.includes('consolidat') || sys.includes('merge memories')) return 'fusion';
  // REM judge — system mentions novelty+plausibility scoring
  if (sys.includes('novelty') && sys.includes('plausibility')) return 'rem_judge';
  // SOUL distillation — system says "guidelines distiller" or "SOUL"
  if (sys.includes('guidelines distiller') || sys.includes('soul')) return 'soul';
  // Self-reflection — system says "self-reflection engine"
  if (sys.includes('self-reflection') || (sys.includes('reflection') && sys.includes('insight'))) return 'reflection';
  // Gap diagnosis — system says "diagnose" + "gap"
  if (sys.includes('diagnos') && sys.includes('gap')) return 'gap_diagnosis';
  // Inner thoughts — system says "inner" + "proactive"
  if (sys.includes('inner') && sys.includes('proactive')) return 'inner_thoughts';

  // ── Combined-text fallback (for prompts without distinctive system prompts) ──
  if (combined.includes('summarize') || (sys.includes('summary') && sys.includes('session'))) return 'summarize';
  if (combined.includes('re-rank') || combined.includes('rerank') || sys.includes('relevance')) return 'rerank';

  return 'default';
}

// ============ Factory ============

/**
 * Create a cognitive mock LLM provider that pattern-matches prompts and
 * returns contextually appropriate structured responses.
 */
export function createCognitiveMockProvider(): CognitiveMockProvider {
  const provider: CognitiveMockProvider = {
    name: 'cognitive-mock',
    callLog: [],
    callCount: 0,

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      provider.callCount++;

      // Extract system and user prompts
      const systemPrompt = request.system ?? '';
      const userPrompt = (request.messages ?? [])
        .filter(m => m.role === 'user')
        .map(m => {
          if (typeof m.content === 'string') return m.content;
          if (Array.isArray(m.content)) {
            return m.content
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map(b => b.text)
              .join(' ');
          }
          return '';
        })
        .join(' ');

      const combinedPrompt = `${systemPrompt} ${userPrompt}`;
      const operation = detectOperation(systemPrompt, userPrompt);

      provider.callLog.push({ operation, timestamp: Date.now() });

      let responseText: string;
      switch (operation) {
        case 'fusion':
          responseText = fusionResponse(combinedPrompt);
          break;
        case 'nrem':
          responseText = nremResponse(combinedPrompt);
          break;
        case 'rem_judge':
          responseText = remJudgeResponse();
          break;
        case 'reflection':
          responseText = reflectionResponse(combinedPrompt);
          break;
        case 'soul':
          responseText = soulResponse();
          break;
        case 'gap_diagnosis':
          responseText = gapDiagnosisResponse(combinedPrompt);
          break;
        case 'inner_thoughts':
          responseText = innerThoughtsResponse();
          break;
        case 'summarize':
          responseText = summarizeResponse(combinedPrompt);
          break;
        case 'rerank':
          responseText = rerankResponse(combinedPrompt);
          break;
        default:
          responseText = 'I understand. Let me help you with that.';
          break;
      }

      return {
        content: [{ type: 'text', text: responseText }] as ContentBlock[],
        stopReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 30 },
        model: 'cognitive-mock',
      };
    },

    isAvailable(): boolean {
      return true;
    },
  };

  return provider;
}
