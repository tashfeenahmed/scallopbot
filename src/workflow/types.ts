export interface WorkflowStep {
  /** Unique identifier used by dependencies and output references. */
  id: string;
  /** Registered Smartbot skill/tool name. */
  tool: string;
  /** Tool arguments. Strings may reference prior output as {{stepId.output}}. */
  args?: Record<string, unknown>;
  /** Steps that must finish successfully first. */
  dependsOn?: string[];
  /** Include this step's output in the final model-visible result. */
  expose?: boolean;
}
export interface WorkflowRequest {
  steps: WorkflowStep[];
  /** Stop scheduling new work after the first failure (default true). */
  stopOnError?: boolean;
  /** Bounded parallelism for independent steps. */
  maxConcurrency?: number;
}

export interface WorkflowStepReport {
  id: string;
  tool: string;
  success: boolean;
  durationMs: number;
  outputBytes: number;
  /** Present only when expose=true (or the step is a default terminal output). */
  output?: string;
  error?: string;
  skipped?: boolean;
}

export interface WorkflowReport {
  success: boolean;
  steps: WorkflowStepReport[];
  executedSteps: number;
  failedSteps: number;
  durationMs: number;
  retainedOutputBytes: number;
  exposedOutputBytes: number;
  suppressedOutputBytes: number;
}
