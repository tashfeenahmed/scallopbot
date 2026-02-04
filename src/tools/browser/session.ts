/**
 * Browser Session Manager
 *
 * Manages a persistent Playwright browser instance for automation.
 * Uses lazy loading - browser only starts when first needed.
 *
 * Note: Requires optional dependency playwright
 */

import type { Logger } from 'pino';
import type {
  BrowserSessionConfig,
  BrowserSessionState,
  PageSnapshot,
  ElementRef,
  ScreenshotResult,
  BrowserCookie,
  NavigateOptions,
  ClickOptions,
  TypeOptions,
  WaitOptions,
} from './types.js';
import { safeImport } from '../../utils/dynamic-import.js';

// Dynamic import for optional dependency
let playwright: any;

async function loadPlaywright(): Promise<boolean> {
  try {
    // Use safe import utility with whitelist validation
    playwright = await safeImport('playwright');
    return playwright !== null;
  } catch {
    return false;
  }
}

/**
 * Singleton browser session manager
 */
export class BrowserSession {
  private static instance: BrowserSession | null = null;

  private browser: any = null;
  private context: any = null;
  private page: any = null;
  private config: BrowserSessionConfig;
  private logger: Logger | null;
  private elementRefs: Map<number, string> = new Map();
  private nextRefId = 1;

  private constructor(config: BrowserSessionConfig = {}) {
    this.config = {
      headless: true,
      viewport: { width: 1920, height: 1080 }, // More realistic viewport
      timeout: 45000, // Increased from 30s for complex pages
      blockResources: false, // Block images/fonts/CSS for faster loads
      ...config,
    };
    this.logger = config.logger || null;
  }

  /**
   * Get or create the browser session instance
   */
  static getInstance(config?: BrowserSessionConfig): BrowserSession {
    if (!BrowserSession.instance) {
      BrowserSession.instance = new BrowserSession(config);
    }
    return BrowserSession.instance;
  }

  /**
   * Reset the singleton (for testing)
   */
  static resetInstance(): void {
    if (BrowserSession.instance) {
      BrowserSession.instance.close().catch(() => {});
      BrowserSession.instance = null;
    }
  }

  /**
   * Check if Playwright is available
   */
  async isAvailable(): Promise<boolean> {
    return loadPlaywright();
  }

  /**
   * Initialize browser if not already open
   */
  private async ensureBrowser(): Promise<void> {
    if (this.browser) return;

    const isAvailable = await loadPlaywright();
    if (!isAvailable) {
      throw new Error(
        'Browser automation requires Playwright. Install with: npm install playwright && npx playwright install chromium'
      );
    }

    this.logger?.info('Launching browser with stealth mode...');

    // Stealth browser launch options to avoid detection
    this.browser = await playwright.chromium.launch({
      headless: this.config.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    });

    // Realistic user agents (rotated based on session)
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    ];
    const randomUserAgent = this.config.userAgent || userAgents[Math.floor(Math.random() * userAgents.length)];

    // Check for local proxy (residential proxy via gost)
    const proxyServer = process.env.BROWSER_PROXY || 'http://127.0.0.1:8888';
    const useProxy = process.env.BROWSER_USE_PROXY !== 'false';

    this.context = await this.browser.newContext({
      viewport: this.config.viewport,
      userAgent: randomUserAgent,
      // Use residential proxy if available
      ...(useProxy && { proxy: { server: proxyServer } }),
      // Stealth settings
      locale: 'en-US',
      timezoneId: 'America/New_York',
      geolocation: { latitude: 40.7128, longitude: -74.0060 }, // NYC
      permissions: ['geolocation'],
      colorScheme: 'light',
      // Bypass CSP to allow scripts
      bypassCSP: true,
      // Ignore HTTPS errors (some proxies may have cert issues)
      ignoreHTTPSErrors: true,
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.config.timeout || 45000);

    // Block heavy resources if configured (faster page loads)
    if (this.config.blockResources) {
      await this.page.route('**/*', (route: any) => {
        const resourceType = route.request().resourceType();
        if (['image', 'font', 'stylesheet', 'media'].includes(resourceType)) {
          route.abort();
        } else {
          route.continue();
        }
      });
      this.logger?.debug('Resource blocking enabled for images, fonts, stylesheets, media');
    }

    // Additional stealth: Remove webdriver flag and automation indicators
    await this.page.addInitScript(`
      // Remove webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
      // Mock plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });
      // Mock languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
      // Mock chrome object
      window.chrome = {
        runtime: {},
      };
      // Mock permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: 'denied' })
          : originalQuery(parameters);
    `);

    this.logger?.info({ proxy: useProxy ? proxyServer : 'none', userAgent: randomUserAgent.substring(0, 50) }, 'Browser launched with stealth mode');
  }

  /**
   * Get current session state
   */
  async getState(): Promise<BrowserSessionState> {
    if (!this.page) {
      return { isOpen: false };
    }

    try {
      return {
        isOpen: true,
        currentUrl: this.page.url(),
        pageTitle: await this.page.title(),
      };
    } catch {
      return { isOpen: false };
    }
  }

  /**
   * Navigate to a URL
   */
  async navigate(url: string, options: NavigateOptions = {}): Promise<void> {
    await this.ensureBrowser();

    this.logger?.info({ url }, 'Navigating to URL');

    // Use networkidle for more reliable page loads on JS-heavy sites
    const waitUntil = options.waitUntil || 'domcontentloaded';

    await this.page.goto(url, {
      waitUntil,
      timeout: options.timeout || 60000, // 60s for navigation
    });

    // Clear element refs after navigation
    this.clearRefs();
  }

  /**
   * Wait for network to become idle (no requests for 500ms)
   */
  async waitForNetworkIdle(timeout?: number): Promise<void> {
    await this.ensureBrowser();

    this.logger?.debug('Waiting for network idle');

    try {
      await this.page.waitForLoadState('networkidle', {
        timeout: timeout || 15000, // 15s max wait for network idle
      });
    } catch {
      // Network idle timeout is not fatal - page may have continuous requests
      this.logger?.debug('Network idle timeout - continuing anyway');
    }
  }

  /**
   * Take a snapshot of the current page with element references
   */
  async snapshot(): Promise<PageSnapshot> {
    await this.ensureBrowser();

    this.clearRefs();

    const url = this.page.url();
    const title = await this.page.title();

    // Get interactable elements
    const elements: ElementRef[] = await this.page.evaluate(`
      (() => {
        const interactable = document.querySelectorAll(
          'a, button, input, select, textarea, [role="button"], [role="link"], [onclick], [tabindex]'
        );

        return Array.from(interactable).map((el, index) => {
          const rect = el.getBoundingClientRect();
          const tag = el.tagName.toLowerCase();
          const text =
            el.innerText?.trim().substring(0, 100) ||
            el.value?.substring(0, 100) ||
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            '';

          // Build a unique selector
          let selector = tag;
          if (el.id) {
            selector = '#' + el.id;
          } else if (el.name) {
            selector = tag + '[name="' + el.name + '"]';
          } else if (el.className && typeof el.className === 'string') {
            const classes = el.className.split(' ').filter(c => c).slice(0, 2);
            if (classes.length) {
              selector = tag + '.' + classes.join('.');
            }
          }

          return {
            ref: index + 1,
            tag,
            text: text || undefined,
            role: el.getAttribute('role') || undefined,
            selector,
            attributes: {
              type: el.type || undefined,
              href: el.href || undefined,
              name: el.name || undefined,
              placeholder: el.placeholder || undefined,
            },
            rect:
              rect.width > 0 && rect.height > 0
                ? {
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                  }
                : undefined,
          };
        });
      })()
    `);

    // Store refs for later use
    for (const el of elements) {
      this.elementRefs.set(el.ref, el.selector);
    }
    this.nextRefId = elements.length + 1;

    // Get page text content
    const text = await this.page.evaluate(`
      document.body?.innerText?.substring(0, 5000) || ''
    `);

    return {
      url,
      title,
      elements: elements.filter((el) => el.rect), // Only visible elements
      text,
      timestamp: Date.now(),
    };
  }

  /**
   * Click an element by ref number, selector, or text
   */
  async click(
    target: number | string,
    options: ClickOptions = {}
  ): Promise<void> {
    await this.ensureBrowser();

    const selector = this.resolveTarget(target);
    this.logger?.info({ target, selector }, 'Clicking element');

    await this.page.click(selector, {
      button: options.button || 'left',
      clickCount: options.clickCount || 1,
      delay: options.delay,
    });
  }

  /**
   * Type text into an element
   */
  async type(
    target: number | string,
    text: string,
    options: TypeOptions = {}
  ): Promise<void> {
    await this.ensureBrowser();

    const selector = this.resolveTarget(target);
    this.logger?.info({ target, selector, textLength: text.length }, 'Typing into element');

    if (options.clear) {
      await this.page.fill(selector, '');
    }

    await this.page.type(selector, text, {
      delay: options.delay || 50,
    });
  }

  /**
   * Fill an input (faster than type, replaces content)
   */
  async fill(target: number | string, value: string): Promise<void> {
    await this.ensureBrowser();

    const selector = this.resolveTarget(target);
    this.logger?.info({ target, selector }, 'Filling input');

    await this.page.fill(selector, value);
  }

  /**
   * Press a key or key combination
   */
  async press(key: string): Promise<void> {
    await this.ensureBrowser();

    this.logger?.info({ key }, 'Pressing key');
    await this.page.keyboard.press(key);
  }

  /**
   * Select option from dropdown
   */
  async select(target: number | string, value: string): Promise<void> {
    await this.ensureBrowser();

    const selector = this.resolveTarget(target);
    this.logger?.info({ target, selector, value }, 'Selecting option');

    await this.page.selectOption(selector, value);
  }

  /**
   * Wait for an element
   */
  async waitForElement(
    selector: string,
    options: WaitOptions = {}
  ): Promise<void> {
    await this.ensureBrowser();

    this.logger?.info({ selector }, 'Waiting for element');

    await this.page.waitForSelector(selector, {
      timeout: options.timeout || this.config.timeout,
      state: options.state || 'visible',
    });
  }

  /**
   * Wait for navigation to complete
   */
  async waitForNavigation(options: NavigateOptions = {}): Promise<void> {
    await this.ensureBrowser();

    this.logger?.info('Waiting for navigation');

    await this.page.waitForNavigation({
      waitUntil: options.waitUntil || 'domcontentloaded',
      timeout: options.timeout || this.config.timeout,
    });
  }

  /**
   * Wait for a specific amount of time
   */
  async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Take a screenshot
   */
  async screenshot(fullPage: boolean = false): Promise<ScreenshotResult> {
    await this.ensureBrowser();

    this.logger?.info({ fullPage }, 'Taking screenshot');

    const buffer = await this.page.screenshot({
      type: 'png',
      fullPage,
    });

    const viewport = this.page.viewportSize();

    return {
      data: buffer,
      format: 'png',
      width: viewport?.width || 1280,
      height: fullPage ? buffer.length / 4 / (viewport?.width || 1280) : viewport?.height || 720,
    };
  }

  /**
   * Take a screenshot and return as base64 for model analysis
   */
  async screenshotBase64(fullPage: boolean = false): Promise<{ base64: string; width: number; height: number; mimeType: string }> {
    await this.ensureBrowser();

    this.logger?.info({ fullPage }, 'Taking screenshot for analysis');

    const buffer = await this.page.screenshot({
      type: 'png',
      fullPage,
    });

    const viewport = this.page.viewportSize();

    return {
      base64: buffer.toString('base64'),
      width: viewport?.width || 1280,
      height: fullPage ? Math.round(buffer.length / 4 / (viewport?.width || 1280)) : viewport?.height || 720,
      mimeType: 'image/png',
    };
  }

  /**
   * Extract text content from page or element
   */
  async extractText(selector?: string): Promise<string> {
    await this.ensureBrowser();

    if (selector) {
      return this.page.textContent(selector) || '';
    }

    return this.page.evaluate(`document.body?.innerText || ''`);
  }

  /**
   * Extract HTML content
   */
  async extractHtml(selector?: string): Promise<string> {
    await this.ensureBrowser();

    if (selector) {
      return this.page.innerHTML(selector);
    }

    return this.page.content();
  }

  /**
   * Get attribute value from element
   */
  async getAttribute(
    target: number | string,
    attribute: string
  ): Promise<string | null> {
    await this.ensureBrowser();

    const selector = this.resolveTarget(target);
    return this.page.getAttribute(selector, attribute);
  }

  /**
   * Check if element exists
   */
  async elementExists(selector: string): Promise<boolean> {
    await this.ensureBrowser();

    const element = await this.page.$(selector);
    return element !== null;
  }

  /**
   * Scroll element into view
   */
  async scrollIntoView(target: number | string): Promise<void> {
    await this.ensureBrowser();

    const selector = this.resolveTarget(target);
    await this.page.locator(selector).scrollIntoViewIfNeeded();
  }

  /**
   * Scroll page by amount
   */
  async scroll(x: number, y: number): Promise<void> {
    await this.ensureBrowser();

    await this.page.evaluate(`window.scrollBy(${x}, ${y})`);
  }

  /**
   * Go back in history
   */
  async goBack(): Promise<void> {
    await this.ensureBrowser();
    await this.page.goBack();
    this.clearRefs();
  }

  /**
   * Go forward in history
   */
  async goForward(): Promise<void> {
    await this.ensureBrowser();
    await this.page.goForward();
    this.clearRefs();
  }

  /**
   * Reload page
   */
  async reload(): Promise<void> {
    await this.ensureBrowser();
    await this.page.reload();
    this.clearRefs();
  }

  /**
   * Set cookies
   */
  async setCookies(cookies: BrowserCookie[]): Promise<void> {
    await this.ensureBrowser();
    await this.context.addCookies(cookies);
  }

  /**
   * Get cookies
   */
  async getCookies(): Promise<BrowserCookie[]> {
    await this.ensureBrowser();
    return this.context.cookies();
  }

  /**
   * Clear cookies
   */
  async clearCookies(): Promise<void> {
    await this.ensureBrowser();
    await this.context.clearCookies();
  }

  /**
   * Execute JavaScript in page context
   */
  async evaluate<T>(script: string): Promise<T> {
    await this.ensureBrowser();
    return this.page.evaluate(script);
  }

  /**
   * Close the browser session
   */
  async close(): Promise<void> {
    if (this.browser) {
      this.logger?.info('Closing browser');
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.clearRefs();
    }
  }

  /**
   * Resolve target to selector
   */
  private resolveTarget(target: number | string): string {
    // Handle numeric refs (either as number or numeric string like "5")
    const numTarget = typeof target === 'number' ? target : parseInt(target, 10);
    if (!isNaN(numTarget) && String(numTarget) === String(target).trim()) {
      const selector = this.elementRefs.get(numTarget);
      if (!selector) {
        throw new Error(
          `Element ref ${numTarget} not found. Run snapshot() first to get element refs.`
        );
      }
      return selector;
    }

    // If starts with text=, use text selector
    if (typeof target === 'string' && target.startsWith('text=')) {
      return target;
    }

    // Otherwise treat as CSS selector
    return String(target);
  }

  /**
   * Clear element refs
   */
  private clearRefs(): void {
    this.elementRefs.clear();
    this.nextRefId = 1;
  }
}
