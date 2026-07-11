/**
 * Deterministic social-quality checks for generated proactive messages.
 *
 * This is intentionally separate from the internal-output sanitizer. A string
 * can be safe from prompt/reasoning leakage and still be an awkward,
 * manipulative, or surveillance-shaped interruption.
 */

export type ProactiveQualityIssue =
  | 'empty'
  | 'too_long'
  | 'too_many_questions'
  | 'too_many_paragraphs'
  | 'faux_intimacy'
  | 'surveillance_language'
  | 'pressure_or_shame'
  | 'unsupported_diagnosis'
  | 'canned_checkin'
  | 'generic_checkin'
  | 'robotic_prompt';

export interface ProactiveMessageQuality {
  /** 0-100; useful for evaluations and observability, not only pass/fail. */
  score: number;
  /** Hard relational/safety failures that must never be delivered. */
  hardFailures: ProactiveQualityIssue[];
  /** Naturalness problems that should trigger a rewrite for generated text. */
  qualityIssues: ProactiveQualityIssue[];
  /** True when a generated message is both safe and natural enough to send. */
  acceptable: boolean;
}

const FAUX_INTIMACY_RE = /\b(?:i (?:miss(?:ed)?|love|adore) you|i(?:'ve| have) been thinking about you|as your friend|your (?:best )?friend|we(?:'re| are) in this together forever)\b/i;
const SURVEILLANCE_RE = /\b(?:i noticed (?:you(?:'ve| have)?|that you) (?:have )?been (?:quiet|away|less active|replying less)|you(?:'ve| have) been (?:quiet|less active)|haven't heard from you|your (?:messages|replies) (?:are|have been) (?:shorter|less frequent)|you haven't checked in)\b/i;
const PRESSURE_RE = /\b(?:why haven['’]?t you|you should have|you need to (?:reply|respond|answer)|you owe|no excuses|don['’]?t let me down|you(?:'re| are) falling behind|you failed to)\b/i;
const DIAGNOSIS_RE = /\b(?:you (?:are|seem|sound) (?:depressed|anxious|manic|burned out|burnt out)|this means you(?:'re| are) (?:depressed|anxious))\b/i;
const CANNED_CHECKIN_RE = /\b(?:just checking in|wanted to check in|thought i['’]?d check in|(?:just\s+)?wanted to see how you (?:are|were)(?: doing)?|(?:just\s+)?seeing how you(?:['’]re| are) (?:doing|getting on)|hope you(?:['’]re| are) (?:doing )?well|how are things(?: going)?|how['’]?s everything)\b/i;
const GENERIC_ONLY_RE = /^(?:hey[,! ]*)?(?:(?:just\s+)?(?:wanted to )?see how you (?:are|were)(?: doing)?|how are you(?: doing)?|how(?:'s| is) your day(?: going)?|how did your day go|anything to (?:follow up|work on)|what['’]?s up|how are things(?: going)?|how['’]?s everything)[?.! ]*$/i;
const GENERIC_OFFER_RE = /\b(?:if there(?:['’]s| is) anything\b|if you have anything\b|if anything(?:['’]s| is) on your mind\b|feel free to (?:share|reach out)\b|let me know if (?:you need|there(?:['’]s| is)) anything\b)/i;
const ROBOTIC_REFLECTION_RE = /\b(?:(?:take a moment|consider|before you wrap up).{0,100}\b(?:recap|review|reflect|note|identify)\b|(?:recap|review) (?:what happened|your day).{0,100}\b(?:follow[- ]?ups?|action items?)\b|(?:identify|note) any follow[- ]?ups?\b)/i;
const COMPOUND_QUESTION_RE = /\b(?:who|what|when|where|why|how|which|is|are|do|did|does|can|could|would|will|have|has)\b[^?]{0,180}\b(?:and|or)\s+(?:if\s+so[,]?\s*)?(?:who|what|when|where|why|how|which|is|are|do|did|does|can|could|would|will|have|has)\b[^?]*\?/i;
const META_REMINDER_RE = /\b(?:would you like|do you want)\s+(?:me\s+)?to\s+(?:remind|notify|ping)\b|\bwant (?:another|a) reminder\b/i;

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Score generated recipient-facing text without using private user data. */
export function assessProactiveMessage(text: string): ProactiveMessageQuality {
  const message = text.trim();
  const hardFailures: ProactiveQualityIssue[] = [];
  const qualityIssues: ProactiveQualityIssue[] = [];
  let score = 100;

  if (!message) {
    hardFailures.push('empty');
    score = 0;
  }

  if (message.length > 420) {
    hardFailures.push('too_long');
    score -= 45;
  } else if (message.length > 280) {
    qualityIssues.push('too_long');
    score -= 18;
  }

  const questionCount = (message.match(/\?/g) ?? []).length;
  if (questionCount > 1 || COMPOUND_QUESTION_RE.test(message)) {
    hardFailures.push('too_many_questions');
    score -= 35;
  }

  const paragraphCount = message ? message.split(/\n\s*\n/).length : 0;
  if (paragraphCount > 2) {
    hardFailures.push('too_many_paragraphs');
    score -= 30;
  }

  if (FAUX_INTIMACY_RE.test(message)) {
    hardFailures.push('faux_intimacy');
    score -= 60;
  }
  if (SURVEILLANCE_RE.test(message)) {
    hardFailures.push('surveillance_language');
    score -= 60;
  }
  if (PRESSURE_RE.test(message)) {
    hardFailures.push('pressure_or_shame');
    score -= 60;
  }
  if (DIAGNOSIS_RE.test(message)) {
    hardFailures.push('unsupported_diagnosis');
    score -= 60;
  }

  if (CANNED_CHECKIN_RE.test(message)) {
    qualityIssues.push('canned_checkin');
    score -= 28;
  }
  if (GENERIC_ONLY_RE.test(message) || GENERIC_OFFER_RE.test(message)) {
    qualityIssues.push('generic_checkin');
    score -= 45;
  }
  if (ROBOTIC_REFLECTION_RE.test(message)) {
    qualityIssues.push('robotic_prompt');
    score -= 35;
  }
  if (META_REMINDER_RE.test(message)) {
    qualityIssues.push('robotic_prompt');
    score -= 35;
  }

  const uniqueHardFailures = unique(hardFailures);
  const uniqueQualityIssues = unique(qualityIssues);
  const boundedScore = Math.max(0, Math.min(100, score));
  return {
    score: boundedScore,
    hardFailures: uniqueHardFailures,
    qualityIssues: uniqueQualityIssues,
    acceptable:
      uniqueHardFailures.length === 0 &&
      uniqueQualityIssues.length === 0 &&
      boundedScore >= 70,
  };
}
