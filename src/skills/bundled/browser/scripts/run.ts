/**
 * Browser Skill Execution Script
 *
 * Wraps existing BrowserSession to expose browser operations via skill interface.
 * Receives arguments via SKILL_ARGS environment variable.
 */

import { BrowserSession } from '../../../../tools/browser/session.js';

// Types
interface BrowserArgs {
  operation: string;
  url?: string;
  target?: string | number;
  text?: string;
  fullPage?: boolean;
  format?: 'text' | 'html';
  selector?: string;
  /** Wait for network idle before operation (useful for JS-heavy sites) */
  waitForIdle?: boolean;
  /** Block images/fonts/CSS for faster loads */
  blockResources?: boolean;
}

interface BrowserResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
}

// Valid operations
const VALID_OPERATIONS = ['navigate', 'snapshot', 'click', 'type', 'fill', 'extract', 'screenshot', 'screenshot_analyze', 'close'];

/**
 * Output result as JSON and exit
 */
function outputResult(result: BrowserResult): never {
  console.log(JSON.stringify(result));
  process.exit(result.exitCode);
}

/**
 * Parse and validate arguments from SKILL_ARGS
 */
function parseArgs(): BrowserArgs {
  const skillArgsJson = process.env.SKILL_ARGS;

  if (!skillArgsJson) {
    outputResult({
      success: false,
      output: '',
      error: 'SKILL_ARGS environment variable not set',
      exitCode: 1,
    });
  }

  let args: unknown;
  try {
    args = JSON.parse(skillArgsJson);
  } catch (e) {
    outputResult({
      success: false,
      output: '',
      error: `Invalid JSON in SKILL_ARGS: ${e instanceof Error ? e.message : String(e)}`,
      exitCode: 1,
    });
  }

  // Validate args is an object
  if (!args || typeof args !== 'object') {
    outputResult({
      success: false,
      output: '',
      error: 'SKILL_ARGS must be a JSON object',
      exitCode: 1,
    });
  }

  const argsObj = args as Record<string, unknown>;

  // Validate required operation field
  if (!argsObj.operation || typeof argsObj.operation !== 'string') {
    outputResult({
      success: false,
      output: '',
      error: 'Missing or invalid "operation" field in SKILL_ARGS',
      exitCode: 1,
    });
  }

  const operation = argsObj.operation as string;
  if (!VALID_OPERATIONS.includes(operation)) {
    outputResult({
      success: false,
      output: '',
      error: `Invalid operation "${operation}". Must be one of: ${VALID_OPERATIONS.join(', ')}`,
      exitCode: 1,
    });
  }

  // Validate operation-specific required params
  if (operation === 'navigate' && (!argsObj.url || typeof argsObj.url !== 'string')) {
    outputResult({
      success: false,
      output: '',
      error: 'navigate operation requires "url" parameter',
      exitCode: 1,
    });
  }

  if (['click', 'type', 'fill'].includes(operation) && argsObj.target === undefined) {
    outputResult({
      success: false,
      output: '',
      error: `${operation} operation requires "target" parameter`,
      exitCode: 1,
    });
  }

  if (['type', 'fill'].includes(operation) && (!argsObj.text || typeof argsObj.text !== 'string')) {
    outputResult({
      success: false,
      output: '',
      error: `${operation} operation requires "text" parameter`,
      exitCode: 1,
    });
  }

  return argsObj as unknown as BrowserArgs;
}

/**
 * Format snapshot elements for output
 */
function formatSnapshot(snapshot: { url: string; title: string; elements: Array<{ ref: number; tag: string; text?: string; attributes?: Record<string, string | undefined> }> }): string {
  const lines: string[] = [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    '',
    'Interactable elements:',
  ];

  for (const el of snapshot.elements) {
    const attrs: string[] = [];
    if (el.attributes?.href) attrs.push(`href=${el.attributes.href}`);
    if (el.attributes?.type) attrs.push(`type=${el.attributes.type}`);
    if (el.attributes?.name) attrs.push(`name=${el.attributes.name}`);
    if (el.attributes?.placeholder) attrs.push(`placeholder="${el.attributes.placeholder}"`);

    const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
    const textStr = el.text ? ` "${el.text.substring(0, 50)}${el.text.length > 50 ? '...' : ''}"` : '';

    lines.push(`[${el.ref}] <${el.tag}>${textStr}${attrStr}`);
  }

  return lines.join('\n');
}

/**
 * Execute browser operation
 */
async function executeOperation(args: BrowserArgs): Promise<void> {
  // Get session (will create browser if needed)
  // Enable resource blocking for faster loads if requested or for extract operations
  const blockResources = args.blockResources ?? (args.operation === 'extract');
  const session = BrowserSession.getInstance({ headless: true, blockResources });

  try {
    switch (args.operation) {
      case 'navigate': {
        await session.navigate(args.url!);
        // Wait for network idle if requested (helps with JS-heavy sites)
        if (args.waitForIdle) {
          await session.waitForNetworkIdle();
        }
        const state = await session.getState();
        outputResult({
          success: true,
          output: `Navigation complete: ${state.currentUrl} - ${state.pageTitle}`,
          exitCode: 0,
        });
        break;
      }

      case 'snapshot': {
        const snapshot = await session.snapshot();
        outputResult({
          success: true,
          output: formatSnapshot(snapshot),
          exitCode: 0,
        });
        break;
      }

      case 'click': {
        await session.click(args.target!);
        outputResult({
          success: true,
          output: `Clicked element: ${args.target}`,
          exitCode: 0,
        });
        break;
      }

      case 'type': {
        await session.type(args.target!, args.text!);
        outputResult({
          success: true,
          output: `Typed ${args.text!.length} characters into element: ${args.target}`,
          exitCode: 0,
        });
        break;
      }

      case 'fill': {
        await session.fill(args.target!, args.text!);
        outputResult({
          success: true,
          output: `Filled element ${args.target} with value`,
          exitCode: 0,
        });
        break;
      }

      case 'extract': {
        // Wait for network to be idle before extracting (helps with JS-rendered content)
        await session.waitForNetworkIdle();

        let content: string;
        if (args.format === 'html') {
          content = await session.extractHtml(args.selector);
        } else {
          content = await session.extractText(args.selector);
        }
        // Truncate very large content
        const maxLength = 30000;
        const truncated = content.length > maxLength;
        outputResult({
          success: true,
          output: truncated ? content.substring(0, maxLength) + '\n\n[Content truncated at 30KB]' : content,
          exitCode: 0,
        });
        break;
      }

      case 'screenshot': {
        const result = await session.screenshot(args.fullPage ?? false);
        outputResult({
          success: true,
          output: `Screenshot captured: ${result.width}x${result.height} ${result.format} (${result.data.length} bytes)`,
          exitCode: 0,
        });
        break;
      }

      case 'screenshot_analyze': {
        // Wait for network idle to ensure page is fully rendered
        await session.waitForNetworkIdle();

        const result = await session.screenshotBase64(args.fullPage ?? false);
        // Return base64 image data that can be sent to the model for analysis
        outputResult({
          success: true,
          output: JSON.stringify({
            type: 'image',
            mimeType: result.mimeType,
            base64: result.base64,
            width: result.width,
            height: result.height,
            description: 'Screenshot of current page for visual analysis. Send this to the model to understand page content.',
          }),
          exitCode: 0,
        });
        break;
      }

      case 'close': {
        await session.close();
        BrowserSession.resetInstance();
        outputResult({
          success: true,
          output: 'Browser session closed',
          exitCode: 0,
        });
        break;
      }

      default:
        outputResult({
          success: false,
          output: '',
          error: `Unknown operation: ${args.operation}`,
          exitCode: 1,
        });
    }
  } catch (error) {
    const err = error as Error;
    outputResult({
      success: false,
      output: '',
      error: `Browser operation failed: ${err.message}`,
      exitCode: 1,
    });
  }
}

// Main execution
const args = parseArgs();
executeOperation(args);
