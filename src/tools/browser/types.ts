/**
 * Browser tool types and interfaces
 */

import type { Logger } from 'pino';

/**
 * Element reference from page snapshot
 */
export interface ElementRef {
  ref: number;
  tag: string;
  text?: string;
  role?: string;
  selector: string;
  attributes?: Record<string, string>;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Page snapshot with element references
 */
export interface PageSnapshot {
  url: string;
  title: string;
  elements: ElementRef[];
  text: string;
  timestamp: number;
}

/**
 * Screenshot result
 */
export interface ScreenshotResult {
  data: Buffer;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
}

/**
 * Browser session configuration
 */
export interface BrowserSessionConfig {
  headless?: boolean;
  viewport?: { width: number; height: number };
  userAgent?: string;
  timeout?: number;
  /** Block images, fonts, stylesheets for faster page loads */
  blockResources?: boolean;
  logger?: Logger;
}

/**
 * Browser session state
 */
export interface BrowserSessionState {
  isOpen: boolean;
  currentUrl?: string;
  pageTitle?: string;
  lastSnapshot?: PageSnapshot;
}

/**
 * Cookie for browser session
 */
export interface BrowserCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * Navigation options
 */
export interface NavigateOptions {
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
}

/**
 * Click options
 */
export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  delay?: number;
}

/**
 * Type options
 */
export interface TypeOptions {
  delay?: number;
  clear?: boolean;
}

/**
 * Wait options
 */
export interface WaitOptions {
  timeout?: number;
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
}

/**
 * Extract options
 */
export interface ExtractOptions {
  selector?: string;
  attribute?: string;
  includeHidden?: boolean;
}
