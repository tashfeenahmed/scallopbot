/**
 * Affect classifier — core computation layer.
 *
 * Pure function that takes user message text and returns
 * {valence, arousal, emotion, confidence} using AFINN-165 for
 * valence, a curated arousal word list, VADER-style negation/booster
 * heuristics, and Russell circumplex emotion mapping.
 *
 * No database access, no side effects, no async.
 * Only classify user messages (caller responsibility).
 */

import { afinn165 } from 'afinn-165';
import {
  AROUSAL_MAP,
  NEGATION_WORDS,
  BOOSTER_DICT,
  EMOJI_VALENCE,
  N_SCALAR,
} from './affect-lexicon.js';

// ============ Types ============

export type EmotionLabel =
  | 'happy'
  | 'excited'
  | 'calm'
  | 'content'
  | 'sad'
  | 'angry'
  | 'anxious'
  | 'frustrated'
  | 'neutral';

export interface RawAffect {
  /** Valence score from -1.0 (very negative) to +1.0 (very positive) */
  valence: number;
  /** Arousal score from -1.0 (very low energy) to +1.0 (very high energy) */
  arousal: number;
  /** Discrete emotion label from Russell's circumplex model */
  emotion: EmotionLabel;
  /** Confidence 0.0-1.0 based on proportion of matched sentiment words */
  confidence: number;
}

// ============ Tokenizer ============

/** Regex to match emoji characters (common Unicode emoji ranges) */
const EMOJI_RE =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}❤️💔💕]/gu;

/**
 * Tokenize text into lowercase words and emoji.
 * Handles contractions by stripping apostrophes (don't → dont).
 * Preserves emoji as separate tokens.
 */
export function tokenize(text: string): string[] {
  if (!text || !text.trim()) return [];

  const tokens: string[] = [];

  // Extract emoji first
  const emojiMatches = text.match(EMOJI_RE);
  if (emojiMatches) {
    for (const emoji of emojiMatches) {
      // Only add if it's a recognized emoji in our map
      // Also handle multi-codepoint emoji like ❤️
      if (EMOJI_VALENCE.has(emoji)) {
        tokens.push(emoji);
      }
    }
  }

  // Remove emoji from text before word tokenization
  const textWithoutEmoji = text.replace(EMOJI_RE, ' ');

  // Lowercase, strip apostrophes, split on whitespace/punctuation
  const words = textWithoutEmoji
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  tokens.push(...words);

  return tokens;
}

// ============ Token Scorer ============

interface TokenScores {
  valence: number;
  arousal: number;
  matchCount: number;
}

/**
 * Score an array of tokens for valence and arousal.
 *
 * For each token:
 * 1. Check emoji map → use emoji valence/arousal
 * 2. Check AFINN-165 → normalize -5..+5 to -1..+1
 * 3. Check preceding token for booster → adjust score
 * 4. Check 3 preceding tokens for negation → apply N_SCALAR
 * 5. Check arousal map → accumulate arousal
 * 6. Track match count for confidence
 */
function scoreTokens(tokens: string[]): TokenScores {
  if (tokens.length === 0) return { valence: 0, arousal: 0, matchCount: 0 };

  let valenceSum = 0;
  let arousalSum = 0;
  let valenceCount = 0;
  let arousalCount = 0;
  let matchCount = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // 1. Check emoji
    const emojiScore = EMOJI_VALENCE.get(token);
    if (emojiScore) {
      valenceSum += emojiScore.v;
      arousalSum += emojiScore.a;
      valenceCount++;
      arousalCount++;
      matchCount++;
      continue;
    }

    // 2. Check AFINN-165 for valence
    const afinnScore = afinn165[token] as number | undefined;
    if (afinnScore !== undefined) {
      // Normalize -5..+5 to -1..+1
      let normalizedValence = afinnScore / 5;

      // 3. Check preceding token for booster
      if (i > 0) {
        const boosterVal = BOOSTER_DICT[tokens[i - 1]];
        if (boosterVal !== undefined) {
          // Amplify or dampen based on sign of booster and sentiment
          if (normalizedValence > 0) {
            normalizedValence += boosterVal;
          } else if (normalizedValence < 0) {
            normalizedValence -= boosterVal;
          }
        }
      }

      // 4. Check 3 preceding tokens for negation
      if (hasNegation(tokens, i)) {
        normalizedValence = normalizedValence * N_SCALAR;
      }

      // Clamp to [-1, 1]
      normalizedValence = Math.max(-1, Math.min(1, normalizedValence));

      valenceSum += normalizedValence;
      valenceCount++;
      matchCount++;
    }

    // 5. Check arousal map (independent of AFINN match)
    const arousalScore = AROUSAL_MAP[token];
    if (arousalScore !== undefined) {
      arousalSum += arousalScore;
      arousalCount++;
      // Count as match for confidence if not already counted by AFINN
      if (afinnScore === undefined) {
        matchCount++;
      }
    }
  }

  const valence = valenceCount > 0 ? valenceSum / valenceCount : 0;
  const arousal = arousalCount > 0 ? arousalSum / arousalCount : 0;

  return {
    valence: Math.max(-1, Math.min(1, valence)),
    arousal: Math.max(-1, Math.min(1, arousal)),
    matchCount,
  };
}

/**
 * Check if any of the 3 tokens preceding tokenIndex are negation words.
 */
function hasNegation(tokens: string[], tokenIndex: number): boolean {
  for (let i = Math.max(0, tokenIndex - 3); i < tokenIndex; i++) {
    if (NEGATION_WORDS.has(tokens[i])) {
      return true;
    }
  }
  return false;
}

// ============ Emotion Mapping ============

/**
 * Map valence and arousal coordinates to a discrete emotion label
 * using Russell's circumplex model of affect.
 *
 * Quadrants:
 * - Q1 (v>0, a>0): 'excited' (high arousal) or 'happy' (moderate)
 * - Q2 (v>0, a<=0): 'content' (high valence) or 'calm' (moderate)
 * - Q3 (v<=0, a<=0): 'sad'
 * - Q4 (v<=0, a>0): 'angry' (extreme), 'anxious' (moderate), 'frustrated' (mild)
 * - Center: 'neutral' (|v|<0.1 && |a|<0.15)
 */
export function mapToEmotion(valence: number, arousal: number): EmotionLabel {
  // Dead zone: near origin = neutral
  if (Math.abs(valence) < 0.1 && Math.abs(arousal) < 0.15) return 'neutral';

  // Q1: High valence, High arousal → excited/happy
  if (valence > 0 && arousal > 0) {
    return arousal > 0.3 ? 'excited' : 'happy';
  }
  // Q2: High valence, Low arousal → calm/content
  if (valence > 0 && arousal <= 0) {
    return valence > 0.3 ? 'content' : 'calm';
  }
  // Q3: Low valence, Low arousal → sad
  if (valence <= 0 && arousal <= 0) {
    return 'sad';
  }
  // Q4: Low valence, High arousal → angry/anxious/frustrated
  if (valence <= 0 && arousal > 0) {
    if (valence < -0.3 && arousal > 0.3) return 'angry';
    if (arousal > 0.2) return 'anxious';
    return 'frustrated';
  }

  return 'neutral';
}

// ============ Main Classifier ============

/**
 * Classify the affect of a text message.
 *
 * Returns valence (-1..+1), arousal (-1..+1), emotion label, and confidence (0..1).
 * Pure function — no side effects, no async, no database access.
 *
 * Only classify user messages. Bot messages should not be classified
 * (caller responsibility — this function has no knowledge of message source).
 */
export function classifyAffect(text: string): RawAffect {
  const tokens = tokenize(text);

  if (tokens.length === 0) {
    return { valence: 0, arousal: 0, emotion: 'neutral', confidence: 0 };
  }

  const { valence, arousal, matchCount } = scoreTokens(tokens);
  const emotion = mapToEmotion(valence, arousal);
  const confidence = Math.min(1.0, matchCount / tokens.length);

  return { valence, arousal, emotion, confidence };
}
