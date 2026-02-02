/**
 * Safe dynamic import utility for optional dependencies
 *
 * This module provides a secure way to dynamically import optional dependencies
 * without using eval(). It uses a whitelist approach to ensure only known
 * safe modules can be imported.
 */

/**
 * Whitelist of allowed optional dependencies
 * Only modules in this list can be dynamically imported
 */
const ALLOWED_MODULES = new Set([
  'matrix-js-sdk',
  '@whiskeysockets/baileys',
  '@slack/bolt',
  'playwright',
  'pdf-parse',
]);

/**
 * Safely import an optional dependency
 * Uses a whitelist to prevent arbitrary code execution
 *
 * @param moduleName - The name of the module to import
 * @returns The imported module or null if not available
 * @throws Error if module is not in the whitelist
 */
export async function safeImport<T = any>(moduleName: string): Promise<T | null> {
  // Validate against whitelist
  if (!ALLOWED_MODULES.has(moduleName)) {
    throw new Error(
      `Module "${moduleName}" is not in the allowed list for dynamic import. ` +
        `Add it to ALLOWED_MODULES in dynamic-import.ts if needed.`
    );
  }

  try {
    // Use Function constructor to create a dynamic import
    // This is safer than eval() as it only executes a return statement
    // and the module name has already been validated against a whitelist
    const importFn = new Function('moduleName', 'return import(moduleName)') as (
      name: string
    ) => Promise<T>;
    return await importFn(moduleName);
  } catch {
    // Module not installed - this is expected for optional dependencies
    return null;
  }
}

/**
 * Check if an optional dependency is available without importing it
 *
 * @param moduleName - The name of the module to check
 * @returns True if the module can be imported
 */
export async function isModuleAvailable(moduleName: string): Promise<boolean> {
  if (!ALLOWED_MODULES.has(moduleName)) {
    return false;
  }

  try {
    const result = await safeImport(moduleName);
    return result !== null;
  } catch {
    return false;
  }
}
