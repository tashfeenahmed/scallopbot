/**
 * Unified Browser Tool
 *
 * Single tool for all browser automation operations.
 * Inspired by OpenClaw's browser tool design.
 *
 * Operations:
 * - navigate: Go to a URL
 * - snapshot: Get page elements with refs
 * - click: Click element by ref/selector/text
 * - type: Type text into element
 * - fill: Fill input field (faster than type)
 * - select: Select dropdown option
 * - press: Press keyboard key
 * - screenshot: Capture page image
 * - extract: Get page text/html
 * - wait: Wait for element/time
 * - scroll: Scroll page or element
 * - back/forward/reload: Navigation
 * - close: Close browser
 */

import type { Tool, ToolContext, ToolResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { BrowserSession } from './session.js';

export class BrowserTool implements Tool {
  name = 'browser';
  description = 'Control a web browser for automation tasks';

  definition: ToolDefinition = {
    name: 'browser',
    description: `Browser automation tool. Use to navigate websites, fill forms, click buttons, and extract content.

WORKFLOW:
1. First use "navigate" to go to a URL
2. Use "snapshot" to see available elements with ref numbers
3. Use "click", "type", "fill" with ref numbers to interact
4. Use "screenshot" to capture visual state
5. Use "extract" to get page content

ELEMENT TARGETING:
- By ref number: After snapshot, use the ref number (e.g., 5)
- By text: Use "text=Click me" to find by visible text
- By selector: Use CSS selector (e.g., "#login-btn", ".submit")

OPERATIONS:
- navigate: Go to URL
- snapshot: Get clickable elements with refs
- click: Click element
- type: Type text character by character
- fill: Set input value instantly
- select: Choose dropdown option
- press: Press key (Enter, Tab, etc.)
- screenshot: Capture page (returns base64)
- extract: Get page text or HTML
- wait: Wait for element or time
- scroll: Scroll page
- back/forward/reload: Browser navigation
- close: Close browser session`,
    input_schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'navigate',
            'snapshot',
            'click',
            'type',
            'fill',
            'select',
            'press',
            'screenshot',
            'extract',
            'wait',
            'scroll',
            'back',
            'forward',
            'reload',
            'close',
          ],
          description: 'The browser operation to perform',
        },
        url: {
          type: 'string',
          description: 'URL to navigate to (for navigate operation)',
        },
        target: {
          type: 'string',
          description:
            'Element to interact with: ref number from snapshot (as string), "text=..." for text match, or CSS selector',
        },
        text: {
          type: 'string',
          description: 'Text to type or fill',
        },
        value: {
          type: 'string',
          description: 'Value for select operation',
        },
        key: {
          type: 'string',
          description: 'Key to press (Enter, Tab, Escape, etc.)',
        },
        selector: {
          type: 'string',
          description: 'CSS selector for wait/extract operations',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds',
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture full page screenshot (default: false)',
        },
        format: {
          type: 'string',
          enum: ['text', 'html'],
          description: 'Extract format (default: text)',
        },
        x: {
          type: 'number',
          description: 'Horizontal scroll amount',
        },
        y: {
          type: 'number',
          description: 'Vertical scroll amount',
        },
      },
      required: ['operation'],
    },
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const operation = input.operation as string;
    const session = BrowserSession.getInstance({ logger: context.logger });

    try {
      switch (operation) {
        case 'navigate': {
          const url = input.url as string;
          if (!url) {
            return { success: false, output: '', error: 'URL is required for navigate' };
          }
          await session.navigate(url, { timeout: input.timeout as number });
          const state = await session.getState();
          return {
            success: true,
            output: `Navigated to: ${state.currentUrl}\nTitle: ${state.pageTitle}`,
          };
        }

        case 'snapshot': {
          const snapshot = await session.snapshot();
          const elementsText = snapshot.elements
            .slice(0, 50) // Limit to prevent huge output
            .map((el) => {
              const text = el.text ? ` "${el.text.substring(0, 40)}"` : '';
              const type = el.attributes?.type ? ` type=${el.attributes.type}` : '';
              return `[${el.ref}] <${el.tag}>${text}${type}`;
            })
            .join('\n');

          return {
            success: true,
            output: `URL: ${snapshot.url}
Title: ${snapshot.title}

Elements (use ref number to interact):
${elementsText}
${snapshot.elements.length > 50 ? `\n... and ${snapshot.elements.length - 50} more elements` : ''}

Page text preview:
${snapshot.text.substring(0, 500)}${snapshot.text.length > 500 ? '...' : ''}`,
          };
        }

        case 'click': {
          const target = input.target;
          if (target === undefined) {
            return { success: false, output: '', error: 'Target is required for click' };
          }
          await session.click(target as number | string);
          // Small delay to let page update
          await session.wait(100);
          return { success: true, output: `Clicked element: ${target}` };
        }

        case 'type': {
          const target = input.target;
          const text = input.text as string;
          if (target === undefined) {
            return { success: false, output: '', error: 'Target is required for type' };
          }
          if (!text) {
            return { success: false, output: '', error: 'Text is required for type' };
          }
          await session.type(target as number | string, text);
          return { success: true, output: `Typed "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}" into element: ${target}` };
        }

        case 'fill': {
          const target = input.target;
          const text = input.text as string;
          if (target === undefined) {
            return { success: false, output: '', error: 'Target is required for fill' };
          }
          if (text === undefined) {
            return { success: false, output: '', error: 'Text is required for fill' };
          }
          await session.fill(target as number | string, text);
          return { success: true, output: `Filled element ${target} with "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"` };
        }

        case 'select': {
          const target = input.target;
          const value = input.value as string;
          if (target === undefined) {
            return { success: false, output: '', error: 'Target is required for select' };
          }
          if (!value) {
            return { success: false, output: '', error: 'Value is required for select' };
          }
          await session.select(target as number | string, value);
          return { success: true, output: `Selected "${value}" in element: ${target}` };
        }

        case 'press': {
          const key = input.key as string;
          if (!key) {
            return { success: false, output: '', error: 'Key is required for press' };
          }
          await session.press(key);
          return { success: true, output: `Pressed key: ${key}` };
        }

        case 'screenshot': {
          const fullPage = (input.fullPage as boolean) || false;
          const result = await session.screenshot(fullPage);
          const base64 = result.data.toString('base64');
          return {
            success: true,
            output: `Screenshot captured (${result.width}x${result.height}, ${fullPage ? 'full page' : 'viewport'})

[Image data: ${base64.length} bytes base64 encoded]

Note: To analyze the screenshot, use vision capabilities if available.`,
          };
        }

        case 'extract': {
          const format = (input.format as string) || 'text';
          const selector = input.selector as string | undefined;

          if (format === 'html') {
            const html = await session.extractHtml(selector);
            return {
              success: true,
              output: html.substring(0, 10000) + (html.length > 10000 ? '\n[Truncated]' : ''),
            };
          }

          const text = await session.extractText(selector);
          return {
            success: true,
            output: text.substring(0, 10000) + (text.length > 10000 ? '\n[Truncated]' : ''),
          };
        }

        case 'wait': {
          const selector = input.selector as string;
          const timeout = (input.timeout as number) || 5000;

          if (selector) {
            await session.waitForElement(selector, { timeout });
            return { success: true, output: `Element "${selector}" is now visible` };
          }

          // Wait for specified time
          await session.wait(timeout);
          return { success: true, output: `Waited ${timeout}ms` };
        }

        case 'scroll': {
          const x = (input.x as number) || 0;
          const y = (input.y as number) || 0;
          const target = input.target;

          if (target !== undefined) {
            await session.scrollIntoView(target as number | string);
            return { success: true, output: `Scrolled element ${target} into view` };
          }

          await session.scroll(x, y);
          return { success: true, output: `Scrolled by (${x}, ${y})` };
        }

        case 'back': {
          await session.goBack();
          const state = await session.getState();
          return { success: true, output: `Navigated back to: ${state.currentUrl}` };
        }

        case 'forward': {
          await session.goForward();
          const state = await session.getState();
          return { success: true, output: `Navigated forward to: ${state.currentUrl}` };
        }

        case 'reload': {
          await session.reload();
          return { success: true, output: 'Page reloaded' };
        }

        case 'close': {
          await session.close();
          BrowserSession.resetInstance();
          return { success: true, output: 'Browser closed' };
        }

        default:
          return {
            success: false,
            output: '',
            error: `Unknown operation: ${operation}`,
          };
      }
    } catch (error) {
      const err = error as Error;
      context.logger.error({ operation, error: err.message }, 'Browser operation failed');
      return {
        success: false,
        output: '',
        error: `Browser ${operation} failed: ${err.message}`,
      };
    }
  }
}
