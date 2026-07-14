import type { Logger } from 'pino';
import type { SkillExecutor } from '../skills/executor.js';
import type { SkillRegistry } from '../skills/registry.js';
import type { Skill } from '../skills/types.js';
import type { ToolUseContent } from '../providers/types.js';
import { redactSensitiveText } from '../security/redaction.js';
import type {
  WorkflowReport,
  WorkflowRequest,
  WorkflowStep,
  WorkflowStepReport,
} from './types.js';

/** Conservative default: orchestration starts read-only and can be widened explicitly. */
export const DEFAULT_WORKFLOW_ALLOWLIST = new Set([
  'read_file',
  'ls',
  'glob',
  'grep',
  'codesearch',
  'web_search',
  'webfetch',
  'memory_search',
  'memory_get',
]);

export interface SafeWorkflowExecutorOptions {
  skillRegistry: SkillRegistry;
  skillExecutor: SkillExecutor;
  logger: Logger;
  allowlist?: Iterable<string>;
  maxSteps?: number;
  maxConcurrency?: number;
  maxRetainedOutputBytes?: number;
  maxExposedOutputBytes?: number;
  maxArgumentBytes?: number;
  /** Strict byte ceiling for every error retained in or exposed by a report. */
  maxErrorBytes?: number;
  /** Final runtime policy check; allowlist alone is not an authorization boundary. */
  isToolAllowed?: (
    toolName: string,
    context: WorkflowExecutionContext,
  ) => boolean | Promise<boolean>;
  /** Shared-brain authorization after references have resolved to final args. */
  authorizeStep?: (
    toolUse: ToolUseContent,
    skill: Skill,
    context: WorkflowExecutionContext,
  ) => boolean | Promise<boolean>;
}

export interface WorkflowExecutionContext {
  workspace: string;
  sessionId: string;
  userId?: string;
  userMessage?: string;
  previousAssistantMessage?: string;
  turnStartedAt?: number;
}

interface InternalStepResult {
  report: WorkflowStepReport;
  output: string;
}

const REFERENCE_PATTERN = /\{\{([A-Za-z][\w-]{0,63})\.output\}\}/g;
const DEFAULT_MAX_ERROR_BYTES = 4 * 1024;
const ERROR_TRUNCATION_MARKER = '\n[workflow error truncated]';
const OUTPUT_TRUNCATION_MARKER = '\n[workflow output truncated]';
const HIDDEN_FAILURE_MESSAGE = 'Tool failed; details hidden by workflow exposure policy';
const POLICY_DENIED_MESSAGE = 'Tool denied by the active session policy at dispatch';

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let output = '';
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

/** Truncate without splitting UTF-8 and keep the optional marker inside the ceiling. */
function truncateUtf8(value: string, maxBytes: number, marker = ''): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(marker);
  if (!marker || markerBytes >= maxBytes) return utf8Prefix(marker || value, maxBytes);
  return `${utf8Prefix(value, maxBytes - markerBytes)}${marker}`;
}

export class SafeWorkflowExecutor {
  private readonly allowlist: Set<string>;
  private readonly maxSteps: number;
  private readonly maxConcurrency: number;
  private readonly maxRetainedOutputBytes: number;
  private readonly maxExposedOutputBytes: number;
  private readonly maxArgumentBytes: number;
  private readonly maxErrorBytes: number;
  private readonly logger: Logger;

  constructor(private readonly options: SafeWorkflowExecutorOptions) {
    this.allowlist = new Set(options.allowlist ?? DEFAULT_WORKFLOW_ALLOWLIST);
    this.allowlist.delete('execute_workflow');
    this.maxSteps = options.maxSteps ?? 20;
    this.maxConcurrency = options.maxConcurrency ?? 4;
    this.maxRetainedOutputBytes = options.maxRetainedOutputBytes ?? 256 * 1024;
    this.maxExposedOutputBytes = options.maxExposedOutputBytes ?? 16 * 1024;
    this.maxArgumentBytes = options.maxArgumentBytes ?? 64 * 1024;
    this.maxErrorBytes = Math.floor(options.maxErrorBytes ?? DEFAULT_MAX_ERROR_BYTES);
    if (!Number.isFinite(this.maxErrorBytes) || this.maxErrorBytes < 64) {
      throw new Error('Workflow maxErrorBytes must be at least 64');
    }
    this.logger = options.logger.child({ module: 'safe-workflow-executor' });
  }

  async execute(
    request: WorkflowRequest,
    context: WorkflowExecutionContext,
  ): Promise<WorkflowReport> {
    const startedAt = Date.now();
    try {
      await this.validate(request, context);
    } catch (error) {
      // Validation failures are returned by the workflow skill as model-visible
      // errors, so they use the same redaction and byte ceiling as step errors.
      throw new Error(this.sanitizeError(error));
    }

    const byId = new Map(request.steps.map((step) => [step.id, step]));
    const dependents = new Set(request.steps.flatMap((step) => step.dependsOn ?? []));
    const explicitExposure = request.steps.some((step) => step.expose === true);
    const results = new Map<string, InternalStepResult>();
    const pending = new Set(request.steps.map((step) => step.id));
    const concurrency = Math.max(1, Math.min(
      Math.floor(request.maxConcurrency ?? this.maxConcurrency),
      this.maxConcurrency,
    ));
    let retainedBytes = 0;
    let halted = false;

    while (pending.size > 0 && !halted) {
      const ready: WorkflowStep[] = [];
      for (const id of pending) {
        const step = byId.get(id)!;
        if ((step.dependsOn ?? []).every((dependency) => results.has(dependency))) {
          ready.push(step);
        }
      }

      // Validation catches cycles, so this is defensive against future mutations.
      if (ready.length === 0) {
        throw new Error('Workflow made no progress; dependency cycle detected');
      }

      for (let offset = 0; offset < ready.length && !halted; offset += concurrency) {
        const batch = ready.slice(offset, offset + concurrency);
        const completed = await Promise.all(batch.map(async (step): Promise<InternalStepResult> => {
          const failedDependency = (step.dependsOn ?? [])
            .map((id) => results.get(id))
            .find((result) => result && !result.report.success);
          if (failedDependency) {
            return {
              output: '',
              report: {
                id: step.id,
                tool: step.tool,
                success: false,
                skipped: true,
                durationMs: 0,
                outputBytes: 0,
                error: 'Skipped because a dependency failed',
              },
            };
          }
          return this.executeStep(step, results, context);
        }));

        for (let index = 0; index < batch.length; index++) {
          const step = batch[index];
          const result = completed[index];
          const outputBytes = Buffer.byteLength(result.output);
          if (retainedBytes + outputBytes > this.maxRetainedOutputBytes) {
            const remaining = Math.max(0, this.maxRetainedOutputBytes - retainedBytes);
            result.output = truncateUtf8(result.output, remaining);
            result.report.outputBytes = Buffer.byteLength(result.output);
            result.report.error = this.sanitizeError(result.report.error
              ? `${result.report.error}; retained output truncated`
              : 'Retained output truncated at workflow byte budget');
          }
          retainedBytes += Buffer.byteLength(result.output);
          results.set(step.id, result);
          pending.delete(step.id);
        }

        if (request.stopOnError !== false && completed.some((result) => !result.report.success)) {
          halted = true;
        }
      }
    }

    // Preserve a complete audit shape without exposing the halted steps' data.
    for (const id of pending) {
      const step = byId.get(id)!;
      results.set(id, {
        output: '',
        report: {
          id,
          tool: step.tool,
          success: false,
          skipped: true,
          durationMs: 0,
          outputBytes: 0,
          error: 'Skipped because workflow stopped after a failure',
        },
      });
    }

    let exposedBytes = 0;
    const reports = request.steps.map((step) => {
      const internal = results.get(step.id)!;
      const report = { ...internal.report };
      // An explicit false is always authoritative. With no explicit selection,
      // omitted `expose` retains the convenient terminal-output default.
      const shouldExpose = step.expose === false
        ? false
        : (explicitExposure ? step.expose === true : !dependents.has(step.id));
      if (shouldExpose && internal.output) {
        const available = Math.max(0, this.maxExposedOutputBytes - exposedBytes);
        report.output = truncateUtf8(internal.output, available, OUTPUT_TRUNCATION_MARKER);
        exposedBytes += Buffer.byteLength(report.output);
      }
      if (!report.success && !shouldExpose) {
        // Tool-provided error text can itself contain the hidden output or
        // resolved arguments. Preserve an auditable failure without content.
        report.error = HIDDEN_FAILURE_MESSAGE;
      }
      if (report.error) report.error = this.sanitizeError(report.error);
      return report;
    });

    const failedSteps = reports.filter((report) => !report.success).length;
    const report: WorkflowReport = {
      success: failedSteps === 0,
      steps: reports,
      executedSteps: reports.filter((step) => !step.skipped).length,
      failedSteps,
      durationMs: Date.now() - startedAt,
      retainedOutputBytes: retainedBytes,
      exposedOutputBytes: exposedBytes,
      suppressedOutputBytes: Math.max(0, retainedBytes - exposedBytes),
    };
    this.logger.info(
      {
        success: report.success,
        steps: report.executedSteps,
        failed: failedSteps,
        suppressedBytes: report.suppressedOutputBytes,
        durationMs: report.durationMs,
      },
      'Workflow completed',
    );
    return report;
  }

  private async executeStep(
    step: WorkflowStep,
    results: Map<string, InternalStepResult>,
    context: WorkflowExecutionContext,
  ): Promise<InternalStepResult> {
    const startedAt = Date.now();
    if (!(await this.isAllowedAtDispatch(step.tool, context))) {
      return {
        output: '',
        report: {
          id: step.id,
          tool: step.tool,
          success: false,
          durationMs: Date.now() - startedAt,
          outputBytes: 0,
          error: POLICY_DENIED_MESSAGE,
        },
      };
    }
    const skill = this.options.skillRegistry.getSkill(step.tool)!;
    const args = this.resolveReferences(step.args ?? {}, results) as Record<string, unknown>;
    const argumentBytes = Buffer.byteLength(JSON.stringify(args));
    if (argumentBytes > this.maxArgumentBytes) {
      return {
        output: '',
        report: {
          id: step.id,
          tool: step.tool,
          success: false,
          durationMs: Date.now() - startedAt,
          outputBytes: 0,
          error: `Resolved arguments exceed ${this.maxArgumentBytes} bytes`,
        },
      };
    }
    if (this.options.authorizeStep) {
      const approved = await this.options.authorizeStep({
        type: 'tool_use',
        id: `workflow:${context.sessionId}:${step.id}`,
        name: step.tool,
        input: args,
      }, skill, context);
      if (!approved) {
        return {
          output: '',
          report: {
            id: step.id,
            tool: step.tool,
            success: false,
            durationMs: Date.now() - startedAt,
            outputBytes: 0,
            error: POLICY_DENIED_MESSAGE,
          },
        };
      }
    }

    try {
      let success: boolean;
      let output: string;
      let error: string | undefined;
      if (skill.handler) {
        const result = await skill.handler({
          args,
          workspace: context.workspace,
          sessionId: context.sessionId,
          userId: context.userId,
        });
        success = result.success;
        output = result.output ?? '';
        error = result.error;
      } else {
        const result = await this.options.skillExecutor.execute(skill, {
          skillName: skill.name,
          args,
          cwd: context.workspace,
          sessionId: context.sessionId,
          userId: context.userId,
        });
        success = result.success;
        output = result.output ?? '';
        error = result.error;
      }
      return {
        output,
        report: {
          id: step.id,
          tool: step.tool,
          success,
          durationMs: Date.now() - startedAt,
          outputBytes: Buffer.byteLength(output),
          error: success ? undefined : this.sanitizeError(error ?? 'Tool failed'),
        },
      };
    } catch (error) {
      return {
        output: '',
        report: {
          id: step.id,
          tool: step.tool,
          success: false,
          durationMs: Date.now() - startedAt,
          outputBytes: 0,
          error: this.sanitizeError(error),
        },
      };
    }
  }

  private resolveReferences(value: unknown, results: Map<string, InternalStepResult>): unknown {
    if (typeof value === 'string') {
      const exact = value.match(/^\{\{([A-Za-z][\w-]{0,63})\.output\}\}$/);
      if (exact) return results.get(exact[1])?.output ?? '';
      return value.replace(REFERENCE_PATTERN, (_match, id: string) => results.get(id)?.output ?? '');
    }
    if (Array.isArray(value)) return value.map((entry) => this.resolveReferences(entry, results));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([key, entry]) => [key, this.resolveReferences(entry, results)]),
      );
    }
    return value;
  }

  private async validate(
    request: WorkflowRequest,
    context: { workspace: string; sessionId: string; userId?: string },
  ): Promise<void> {
    if (!Array.isArray(request.steps) || request.steps.length === 0) {
      throw new Error('Workflow requires at least one step');
    }
    if (request.steps.length > this.maxSteps) {
      throw new Error(`Workflow has ${request.steps.length} steps; maximum is ${this.maxSteps}`);
    }

    const ids = new Set<string>();
    for (const step of request.steps) {
      if (!/^[A-Za-z][\w-]{0,63}$/.test(step.id)) {
        throw new Error(`Invalid workflow step id: ${step.id}`);
      }
      if (ids.has(step.id)) throw new Error(`Duplicate workflow step id: ${step.id}`);
      ids.add(step.id);
      if (!this.allowlist.has(step.tool)) {
        throw new Error(`Tool "${step.tool}" is not allowed in workflows`);
      }
      if (!(await this.isAllowedAtDispatch(step.tool, context))) {
        throw new Error(`Tool "${step.tool}" is denied by the active session policy`);
      }
      const skill: Skill | undefined = this.options.skillRegistry.getSkill(step.tool);
      if (!skill || !skill.available || !skill.hasScripts) {
        throw new Error(`Workflow tool "${step.tool}" is unavailable or not executable`);
      }
    }

    for (const step of request.steps) {
      for (const dependency of step.dependsOn ?? []) {
        if (!ids.has(dependency)) throw new Error(`Step ${step.id} has unknown dependency ${dependency}`);
        if (dependency === step.id) throw new Error(`Step ${step.id} cannot depend on itself`);
      }
      const serializedArgs = JSON.stringify(step.args ?? {});
      for (const match of serializedArgs.matchAll(REFERENCE_PATTERN)) {
        if (!ids.has(match[1])) throw new Error(`Step ${step.id} references unknown step ${match[1]}`);
        if (!(step.dependsOn ?? []).includes(match[1])) {
          throw new Error(`Step ${step.id} must depend on referenced step ${match[1]}`);
        }
      }
    }

    // Kahn's algorithm: reject cycles before any tool has side effects.
    const remaining = new Set(ids);
    const resolved = new Set<string>();
    while (remaining.size > 0) {
      const ready = [...remaining].filter((id) => {
        const step = request.steps.find((candidate) => candidate.id === id)!;
        return (step.dependsOn ?? []).every((dependency) => resolved.has(dependency));
      });
      if (ready.length === 0) throw new Error('Workflow dependency cycle detected');
      for (const id of ready) {
        remaining.delete(id);
        resolved.add(id);
      }
    }
  }

  /** A policy exception is an authorization failure, never permission. */
  private async isAllowedAtDispatch(
    toolName: string,
    context: { workspace: string; sessionId: string; userId?: string },
  ): Promise<boolean> {
    if (!this.options.isToolAllowed) return true;
    try {
      return (await this.options.isToolAllowed(toolName, context)) === true;
    } catch (error) {
      this.logger.warn(
        { toolName, error: this.sanitizeError(error) },
        'Workflow tool policy resolution failed closed',
      );
      return false;
    }
  }

  private sanitizeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error ?? 'Tool failed');
    // Bound before pattern scanning as well as after it, so a hostile native
    // handler cannot turn redaction into an unbounded CPU/memory operation.
    const scanLimit = Math.max(this.maxErrorBytes * 2, this.maxErrorBytes + 1024);
    const boundedRaw = truncateUtf8(raw, scanLimit);
    return truncateUtf8(
      redactSensitiveText(boundedRaw),
      this.maxErrorBytes,
      ERROR_TRUNCATION_MARKER,
    );
  }
}
