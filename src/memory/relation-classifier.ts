/**
 * LLM-based Relationship Classifier for Memory Graph
 *
 * Uses an LLM to intelligently classify how new facts relate to existing facts:
 * - NEW: Completely new, unrelated information
 * - UPDATES: Replaces/contradicts an existing fact (same slot, different value)
 * - EXTENDS: Adds information about an existing entity/relationship
 *
 * Also provides inference capabilities to derive implicit connections.
 */

import type { LLMProvider, CompletionRequest, ContentBlock } from '../providers/types.js';

/**
 * A fact to be classified
 */
export interface FactToClassify {
  content: string;
  subject: string;
  category: string;
}

/**
 * An existing fact for comparison
 */
export interface ExistingFact {
  id: string;
  content: string;
  subject: string;
  category: string;
}

/**
 * Classification result
 */
export interface ClassificationResult {
  classification: 'NEW' | 'UPDATES' | 'EXTENDS';
  targetId?: string; // ID of the fact being updated/extended
  confidence: number;
  reason: string;
}

/**
 * An inferred fact derived from existing facts
 */
export interface InferredFact {
  content: string;
  subject: string;
  category: string;
  derivedFrom: string[]; // IDs of source facts
  confidence: number;
  reason: string;
}

/**
 * Prompt for relationship classification
 */
const CLASSIFICATION_PROMPT = `You are a memory relationship classifier. Given a NEW fact and EXISTING facts, determine how the new fact relates to existing ones.

Classifications:
- NEW: The fact is completely new information, unrelated to existing facts
- UPDATES: The new fact REPLACES an existing fact (same topic/slot, different value)
  Examples: "Lives in Dublin" → "Lives in Wicklow" (location update)
           "Name: John" → "Name: Johnny" (name correction)
- EXTENDS: The new fact adds MORE information about an entity mentioned in existing facts
  Examples: "Flatmate is Hamza" exists, new fact "Hamza works at Google" EXTENDS it
           "Wife is Sarah" exists, new fact "Sarah likes cooking" EXTENDS it

IMPORTANT RULES:
1. Different relationship types are NOT updates of each other:
   - "Flatmate is Hamza" and "Wife is Hayat" are BOTH NEW (different relationships)
   - "Name is Tash" and "Is Pakistani" are BOTH NEW (different attributes)
2. Only classify as UPDATES if it's the SAME slot with a different value
3. EXTENDS means adding info about the SAME entity mentioned in an existing fact

Respond with JSON only:
{
  "classification": "NEW" | "UPDATES" | "EXTENDS",
  "targetId": "id of existing fact if UPDATES or EXTENDS, omit for NEW",
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}`;

/**
 * Prompt for inference
 */
const INFERENCE_PROMPT = `You are a memory inference engine. Given a set of facts, derive NEW implicit facts that logically follow.

Rules:
1. Only infer facts with HIGH confidence (>0.8)
2. Common inferences:
   - If X is user's flatmate and user lives in Y, then X likely lives in Y
   - If X is user's spouse/partner, they likely share location
   - If X works at company Y, X is likely in the same industry as Y
3. Do NOT infer:
   - Opinions or preferences (unless explicitly stated)
   - Speculative information
   - Things that require external knowledge

Respond with JSON only:
{
  "inferences": [
    {
      "content": "the inferred fact",
      "subject": "who it's about",
      "category": "category",
      "derivedFrom": ["id1", "id2"],
      "confidence": 0.0-1.0,
      "reason": "why this inference is valid"
    }
  ]
}

If no confident inferences can be made, return: {"inferences": []}`;

/**
 * Batch classification result for multiple facts
 */
export interface BatchClassificationResult {
  results: ClassificationResult[];
}

/**
 * LLM-based Relationship Classifier
 */
export class RelationshipClassifier {
  private provider: LLMProvider;
  /** Maximum facts to classify in a single batch (to avoid token limits) */
  private maxBatchSize: number;

  constructor(provider: LLMProvider, options?: { maxBatchSize?: number }) {
    this.provider = provider;
    this.maxBatchSize = options?.maxBatchSize ?? 10;
  }

  /**
   * Classify how a new fact relates to existing facts
   */
  async classify(
    newFact: FactToClassify,
    existingFacts: ExistingFact[]
  ): Promise<ClassificationResult> {
    // If no existing facts, it's always NEW
    if (existingFacts.length === 0) {
      return {
        classification: 'NEW',
        confidence: 1.0,
        reason: 'No existing facts to compare against',
      };
    }

    try {
      const prompt = this.buildClassificationPrompt(newFact, existingFacts);

      const request: CompletionRequest = {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1, // Low temperature for consistent classification
        maxTokens: 200,
      };

      const response = await this.provider.complete(request);
      const content = this.extractTextContent(response.content);
      return this.parseClassificationResponse(content);
    } catch (error) {
      // Default to NEW on error
      return {
        classification: 'NEW',
        confidence: 0.5,
        reason: `Classification failed: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Batch classify multiple facts in a single LLM call
   * This is much more efficient than calling classify() for each fact
   */
  async classifyBatch(
    newFacts: FactToClassify[],
    existingFacts: ExistingFact[]
  ): Promise<ClassificationResult[]> {
    // If no new facts, return empty
    if (newFacts.length === 0) {
      return [];
    }

    // If no existing facts, all are NEW
    if (existingFacts.length === 0) {
      return newFacts.map(() => ({
        classification: 'NEW' as const,
        confidence: 1.0,
        reason: 'No existing facts to compare against',
      }));
    }

    // Split into batches if too many facts
    if (newFacts.length > this.maxBatchSize) {
      const results: ClassificationResult[] = [];
      for (let i = 0; i < newFacts.length; i += this.maxBatchSize) {
        const batch = newFacts.slice(i, i + this.maxBatchSize);
        const batchResults = await this.classifyBatch(batch, existingFacts);
        results.push(...batchResults);
      }
      return results;
    }

    try {
      const prompt = this.buildBatchClassificationPrompt(newFacts, existingFacts);

      const request: CompletionRequest = {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        maxTokens: 100 + newFacts.length * 100, // Scale tokens with batch size
      };

      const response = await this.provider.complete(request);
      const content = this.extractTextContent(response.content);
      return this.parseBatchClassificationResponse(content, newFacts.length);
    } catch (error) {
      // Default all to NEW on error
      return newFacts.map(() => ({
        classification: 'NEW' as const,
        confidence: 0.5,
        reason: `Batch classification failed: ${(error as Error).message}`,
      }));
    }
  }

  /**
   * Infer new connections from existing facts
   */
  async inferConnections(existingFacts: ExistingFact[]): Promise<InferredFact[]> {
    // Need at least 2 facts to make inferences
    if (existingFacts.length < 2) {
      return [];
    }

    try {
      const prompt = this.buildInferencePrompt(existingFacts);

      const request: CompletionRequest = {
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        maxTokens: 500,
      };

      const response = await this.provider.complete(request);
      const content = this.extractTextContent(response.content);
      return this.parseInferenceResponse(content);
    } catch {
      return [];
    }
  }

  /**
   * Build the classification prompt
   */
  private buildClassificationPrompt(
    newFact: FactToClassify,
    existingFacts: ExistingFact[]
  ): string {
    const existingFactsStr = existingFacts
      .map((f) => `- [${f.id}] (${f.subject}, ${f.category}): "${f.content}"`)
      .join('\n');

    return `${CLASSIFICATION_PROMPT}

EXISTING FACTS:
${existingFactsStr}

NEW FACT:
Subject: ${newFact.subject}
Category: ${newFact.category}
Content: "${newFact.content}"

Classify this new fact:`;
  }

  /**
   * Build batch classification prompt for multiple facts
   */
  private buildBatchClassificationPrompt(
    newFacts: FactToClassify[],
    existingFacts: ExistingFact[]
  ): string {
    const existingFactsStr = existingFacts
      .map((f) => `- [${f.id}] (${f.subject}, ${f.category}): "${f.content}"`)
      .join('\n');

    const newFactsStr = newFacts
      .map((f, i) => `${i + 1}. Subject: ${f.subject}, Category: ${f.category}, Content: "${f.content}"`)
      .join('\n');

    return `${CLASSIFICATION_PROMPT}

EXISTING FACTS:
${existingFactsStr}

NEW FACTS TO CLASSIFY:
${newFactsStr}

Classify ALL new facts. Respond with a JSON array:
{
  "classifications": [
    {"index": 1, "classification": "NEW|UPDATES|EXTENDS", "targetId": "id or null", "confidence": 0.0-1.0, "reason": "brief explanation"},
    ...
  ]
}`;
  }

  /**
   * Build the inference prompt
   */
  private buildInferencePrompt(existingFacts: ExistingFact[]): string {
    const factsStr = existingFacts
      .map((f) => `- [${f.id}] (${f.subject}, ${f.category}): "${f.content}"`)
      .join('\n');

    return `${INFERENCE_PROMPT}

EXISTING FACTS:
${factsStr}

What can be inferred?`;
  }

  /**
   * Extract text content from LLM response (handles ContentBlock[])
   */
  private extractTextContent(content: ContentBlock[] | string): string {
    if (typeof content === 'string') {
      return content;
    }
    return content
      .map((block) => ('text' in block ? block.text : ''))
      .join('');
  }

  /**
   * Parse the classification response
   */
  private parseClassificationResponse(content: string): ClassificationResult {
    try {
      // Extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      // Validate classification
      const validClassifications = ['NEW', 'UPDATES', 'EXTENDS'];
      if (!validClassifications.includes(parsed.classification)) {
        throw new Error(`Invalid classification: ${parsed.classification}`);
      }

      return {
        classification: parsed.classification,
        targetId: parsed.targetId,
        confidence: parsed.confidence ?? 0.8,
        reason: parsed.reason ?? 'No reason provided',
      };
    } catch {
      // Default to NEW on parse failure
      return {
        classification: 'NEW',
        confidence: 0.5,
        reason: 'Failed to parse classification response',
      };
    }
  }

  /**
   * Parse batch classification response
   */
  private parseBatchClassificationResponse(content: string, expectedCount: number): ClassificationResult[] {
    const defaultResult = (): ClassificationResult => ({
      classification: 'NEW',
      confidence: 0.5,
      reason: 'Failed to parse batch response',
    });

    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return Array(expectedCount).fill(null).map(defaultResult);
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const classifications = parsed.classifications;

      if (!Array.isArray(classifications)) {
        return Array(expectedCount).fill(null).map(defaultResult);
      }

      const validClassifications = ['NEW', 'UPDATES', 'EXTENDS'];
      const results: ClassificationResult[] = [];

      // Build results array in order
      for (let i = 0; i < expectedCount; i++) {
        const item = classifications.find((c: { index: number }) => c.index === i + 1);
        if (item && validClassifications.includes(item.classification)) {
          results.push({
            classification: item.classification,
            targetId: item.targetId || undefined,
            confidence: item.confidence ?? 0.8,
            reason: item.reason ?? 'No reason provided',
          });
        } else {
          results.push(defaultResult());
        }
      }

      return results;
    } catch {
      return Array(expectedCount).fill(null).map(defaultResult);
    }
  }

  /**
   * Parse the inference response
   */
  private parseInferenceResponse(content: string): InferredFact[] {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (!Array.isArray(parsed.inferences)) {
        return [];
      }

      return parsed.inferences
        .filter((inf: InferredFact) =>
          inf.content &&
          inf.subject &&
          inf.category &&
          Array.isArray(inf.derivedFrom) &&
          inf.confidence >= 0.8 // Only high-confidence inferences
        )
        .map((inf: InferredFact) => ({
          content: inf.content,
          subject: inf.subject,
          category: inf.category,
          derivedFrom: inf.derivedFrom,
          confidence: inf.confidence,
          reason: inf.reason ?? 'Inferred from existing facts',
        }));
    } catch {
      return [];
    }
  }
}

/**
 * Options for creating a RelationshipClassifier
 */
export interface RelationshipClassifierOptions {
  /** Maximum facts to classify in a single batch (default: 10) */
  maxBatchSize?: number;
}

/**
 * Create a RelationshipClassifier instance
 */
export function createRelationshipClassifier(
  provider: LLMProvider,
  options?: RelationshipClassifierOptions
): RelationshipClassifier {
  return new RelationshipClassifier(provider, options);
}
