/**
 * Affect detection lexicon resources.
 *
 * Curated arousal word map, negation set, booster/intensifier dictionary,
 * emoji valence+arousal map, and negation scalar constant.
 *
 * AFINN-165 is used for valence scoring (imported externally).
 * Arousal is a separate dimension from valence — high-intensity negative
 * words like "depressed" are LOW arousal, while "furious" is HIGH arousal.
 *
 * Sources:
 * - Russell (1980) circumplex model for arousal placement
 * - VADER (Hutto & Gilbert, 2014) for negation/booster heuristics
 * - Emoji Sentiment Ranking (Novak et al., 2015) for emoji scores
 */

// ============ Arousal Map ============

/**
 * Curated arousal word map. Values range from -1.0 (very low arousal) to +1.0 (very high arousal).
 * Arousal is independent from valence — it measures activation/energy level.
 *
 * High arousal: excited, furious, terrified (energized, activated)
 * Low arousal: calm, tired, depressed (deactivated, lethargic)
 */
export const AROUSAL_MAP: Record<string, number> = {
  // Very high arousal (+0.7 to +1.0)
  ecstatic: 0.9,
  furious: 0.9,
  terrified: 0.9,
  panicked: 0.95,
  enraged: 0.9,
  frantic: 0.85,
  hysterical: 0.85,
  manic: 0.85,
  livid: 0.85,
  raging: 0.9,
  screaming: 0.9,
  explosive: 0.85,
  thrilled: 0.8,
  elated: 0.75,
  exhilarated: 0.85,
  euphoric: 0.85,
  outraged: 0.85,
  horrified: 0.8,
  frenzied: 0.9,
  apoplectic: 0.95,
  incensed: 0.8,
  seething: 0.8,
  irate: 0.8,
  petrified: 0.85,
  aghast: 0.75,
  electrified: 0.85,
  pumped: 0.8,
  stoked: 0.75,
  hyped: 0.8,

  // High arousal (+0.4 to +0.7)
  excited: 0.7,
  angry: 0.65,
  anxious: 0.55,
  surprised: 0.6,
  worried: 0.5,
  eager: 0.55,
  annoyed: 0.45,
  alarmed: 0.6,
  tense: 0.55,
  nervous: 0.5,
  irritated: 0.45,
  enthusiastic: 0.6,
  agitated: 0.6,
  impatient: 0.45,
  determined: 0.4,
  amazed: 0.6,
  astonished: 0.65,
  startled: 0.65,
  delighted: 0.55,
  passionate: 0.6,
  frustrated: 0.5,
  frustrating: 0.5,
  terrible: 0.5,
  horrible: 0.5,
  awful: 0.45,
  dreadful: 0.45,
  fearful: 0.6,
  scared: 0.6,
  afraid: 0.55,
  distressed: 0.55,
  upset: 0.45,
  mad: 0.6,
  pissed: 0.6,
  stressed: 0.55,
  overwhelmed: 0.5,
  restless: 0.45,
  jittery: 0.5,
  wound: 0.45,
  energetic: 0.55,
  vibrant: 0.5,
  animated: 0.5,
  fired: 0.55,
  amped: 0.6,
  edgy: 0.45,
  uneasy: 0.4,

  // Moderate arousal (+0.1 to +0.4)
  happy: 0.3,
  interested: 0.25,
  hopeful: 0.2,
  curious: 0.25,
  alert: 0.3,
  attentive: 0.2,
  engaged: 0.2,
  motivated: 0.25,
  inspired: 0.3,
  proud: 0.25,
  confident: 0.2,
  playful: 0.3,
  amused: 0.25,
  grateful: 0.15,
  thankful: 0.15,
  cheerful: 0.3,
  lively: 0.35,
  peppy: 0.35,
  bubbly: 0.35,
  perky: 0.3,
  chipper: 0.3,
  upbeat: 0.3,
  optimistic: 0.2,
  lighthearted: 0.2,

  // Low arousal (-0.1 to -0.4)
  calm: -0.3,
  relaxed: -0.35,
  tired: -0.4,
  bored: -0.3,
  lazy: -0.35,
  sleepy: -0.4,
  mellow: -0.25,
  passive: -0.3,
  sluggish: -0.4,
  lethargic: -0.45,
  drowsy: -0.4,
  weary: -0.35,
  listless: -0.4,
  indifferent: -0.2,
  resigned: -0.25,
  contemplative: -0.15,
  pensive: -0.15,
  reflective: -0.15,
  thoughtful: -0.1,
  gentle: -0.2,
  tender: -0.15,
  soothing: -0.25,
  comfortable: -0.2,
  cozy: -0.25,
  easygoing: -0.2,
  unhurried: -0.2,
  languid: -0.35,
  subdued: -0.25,
  quiet: -0.3,
  hushed: -0.25,
  soft: -0.2,
  mild: -0.15,
  satisfied: -0.1,
  pleased: -0.1,
  content: -0.15,
  fulfilled: -0.1,
  at_ease: -0.25,

  // Very low arousal (-0.5 to -1.0)
  peaceful: -0.5,
  serene: -0.55,
  tranquil: -0.55,
  still: -0.5,
  numb: -0.6,
  dull: -0.5,
  lifeless: -0.7,
  exhausted: -0.6,
  inert: -0.7,
  dormant: -0.65,
  depleted: -0.6,
  drained: -0.55,
  fatigued: -0.5,
  spent: -0.5,
  wiped: -0.55,
  burnt: -0.5,
  empty: -0.5,
  hollow: -0.55,
  flat: -0.45,
  apathetic: -0.5,
  detached: -0.45,
  disengaged: -0.4,
  withdrawn: -0.45,
  depressed: -0.4,
  melancholy: -0.35,
  gloomy: -0.3,
  somber: -0.35,
  despondent: -0.35,
  dejected: -0.35,
  hopeless: -0.4,
  desolate: -0.5,
  bleak: -0.4,
};

// ============ Negation Words ============

/**
 * Negation tokens derived from VADER sentiment analysis.
 * Contractions are stored without apostrophes (e.g., "dont" matches "don't").
 * Check 3 tokens before a sentiment word for negation.
 */
export const NEGATION_WORDS = new Set([
  'aint',
  'arent',
  'cannot',
  'cant',
  'couldnt',
  'darent',
  'didnt',
  'doesnt',
  'dont',
  'hadnt',
  'hasnt',
  'havent',
  'isnt',
  'mightnt',
  'mustnt',
  'neither',
  'never',
  'no',
  'nobody',
  'none',
  'nope',
  'nor',
  'not',
  'nothing',
  'nowhere',
  'oughtnt',
  'shant',
  'shouldnt',
  'wasnt',
  'werent',
  'without',
  'wont',
  'wouldnt',
  'barely',
  'hardly',
  'scarcely',
  'seldom',
  'rarely',
]);

// ============ Booster / Intensifier Dictionary ============

/**
 * Intensifier words with scalar adjustment values (VADER-derived).
 * Positive values amplify the sentiment word's score.
 * Negative values dampen/reduce the sentiment word's score.
 */
export const BOOSTER_DICT: Record<string, number> = {
  absolutely: 0.293,
  amazingly: 0.293,
  awfully: 0.293,
  completely: 0.293,
  considerably: 0.293,
  decidedly: 0.293,
  deeply: 0.293,
  enormously: 0.293,
  entirely: 0.293,
  especially: 0.293,
  exceptionally: 0.293,
  extremely: 0.293,
  fairly: 0.143,
  incredibly: 0.293,
  less: -0.293,
  little: -0.293,
  marginally: -0.293,
  moderately: 0.143,
  most: 0.293,
  much: 0.293,
  particularly: 0.293,
  purely: 0.293,
  quite: 0.143,
  rather: 0.143,
  really: 0.293,
  remarkably: 0.293,
  slightly: -0.293,
  somewhat: -0.143,
  substantially: 0.293,
  thoroughly: 0.293,
  totally: 0.293,
  tremendously: 0.293,
  uber: 0.293,
  unbelievably: 0.293,
  unusually: 0.293,
  utterly: 0.293,
  very: 0.293,
  so: 0.293,
  super: 0.293,
  hella: 0.293,
  friggin: 0.293,
  freaking: 0.293,
};

// ============ Emoji Valence + Arousal Map ============

/**
 * Common emoji mapped to valence (v) and arousal (a) scores.
 * Covers ~30 frequently used emoji in chat contexts.
 */
export const EMOJI_VALENCE = new Map<string, { v: number; a: number }>([
  // Positive, moderate arousal
  ['😊', { v: 0.6, a: 0.2 }],
  ['😄', { v: 0.7, a: 0.4 }],
  ['😃', { v: 0.7, a: 0.4 }],
  ['😀', { v: 0.6, a: 0.3 }],
  ['🙂', { v: 0.3, a: 0.0 }],
  ['😁', { v: 0.7, a: 0.5 }],
  ['🤗', { v: 0.6, a: 0.3 }],
  ['😍', { v: 0.8, a: 0.6 }],
  ['🥰', { v: 0.8, a: 0.5 }],
  ['❤️', { v: 0.7, a: 0.3 }],
  ['💕', { v: 0.7, a: 0.3 }],
  ['👍', { v: 0.5, a: 0.1 }],
  ['🎉', { v: 0.8, a: 0.7 }],
  ['🥳', { v: 0.8, a: 0.7 }],
  ['✨', { v: 0.5, a: 0.3 }],
  ['🔥', { v: 0.4, a: 0.7 }],

  // Negative, varying arousal
  ['😢', { v: -0.6, a: -0.2 }],
  ['😭', { v: -0.7, a: 0.3 }],
  ['😡', { v: -0.7, a: 0.8 }],
  ['😤', { v: -0.5, a: 0.6 }],
  ['😠', { v: -0.6, a: 0.7 }],
  ['💔', { v: -0.7, a: 0.0 }],
  ['😞', { v: -0.5, a: -0.3 }],
  ['😔', { v: -0.5, a: -0.4 }],
  ['😟', { v: -0.4, a: 0.2 }],
  ['😰', { v: -0.5, a: 0.5 }],
  ['😱', { v: -0.6, a: 0.8 }],
  ['🤬', { v: -0.8, a: 0.9 }],
  ['👎', { v: -0.5, a: 0.1 }],

  // Neutral / ambiguous
  ['🤔', { v: 0.0, a: 0.1 }],
  ['😐', { v: 0.0, a: -0.2 }],
]);

// ============ Negation Scalar ============

/**
 * VADER negation dampening factor.
 * When a negation word precedes a sentiment word, multiply the
 * word's score by N_SCALAR to reverse and dampen it.
 */
export const N_SCALAR = -0.74;
