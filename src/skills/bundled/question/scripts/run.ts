/**
 * Question Skill Execution Script
 *
 * Formats a question with optional choices for display to the user.
 */

export {};

interface QuestionArgs {
  question: string;
  options?: string[];
}

interface SkillResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

function outputResult(result: SkillResult): void {
  console.log(JSON.stringify(result));
  process.exit(result.success ? 0 : 1);
}

function main(): void {
  const skillArgsJson = process.env.SKILL_ARGS;

  if (!skillArgsJson) {
    outputResult({ success: false, output: '', error: 'SKILL_ARGS environment variable not set', exitCode: 1 });
    return;
  }

  let args: QuestionArgs;
  try {
    args = JSON.parse(skillArgsJson);
  } catch (e) {
    outputResult({ success: false, output: '', error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1 });
    return;
  }

  if (!args.question) {
    outputResult({ success: false, output: '', error: 'Missing required parameter: question', exitCode: 1 });
    return;
  }

  let output = args.question;

  if (args.options && args.options.length > 0) {
    output += '\n\nOptions:';
    for (let i = 0; i < args.options.length; i++) {
      output += `\n  ${i + 1}. ${args.options[i]}`;
    }
  }

  outputResult({
    success: true,
    output,
    exitCode: 0,
  });
}

main();
