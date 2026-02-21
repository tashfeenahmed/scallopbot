/**
 * Tests for MCP Configuration and Skill.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadMCPConfig, saveMCPConfig, hasMCPConfig, type MCPServerConfig } from '../../../config/mcp-config.js';

const TEST_DIR = path.join(os.tmpdir(), `smartbot-mcp-test-${Date.now()}`);
const TEST_CONFIG_PATH = path.join(TEST_DIR, 'mcp.json');

afterEach(() => {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Cleanup failure is non-fatal in tests
  }
});

describe('loadMCPConfig', () => {
  it('returns empty array when file does not exist', () => {
    const result = loadMCPConfig('/nonexistent/path/mcp.json');
    expect(result).toEqual([]);
  });

  it('loads valid config', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      servers: [
        { name: 'test-server', command: 'echo', args: ['hello'] },
        { name: 'another', command: 'npx', args: ['-y', 'some-package'], env: { API_KEY: 'test' } },
      ],
    }));

    const result = loadMCPConfig(TEST_CONFIG_PATH);
    expect(result.length).toBe(2);
    expect(result[0].name).toBe('test-server');
    expect(result[0].command).toBe('echo');
    expect(result[1].env).toEqual({ API_KEY: 'test' });
  });

  it('returns empty array for invalid JSON', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, 'not valid json');

    expect(loadMCPConfig(TEST_CONFIG_PATH)).toEqual([]);
  });

  it('returns empty array when servers field is missing', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ foo: 'bar' }));

    expect(loadMCPConfig(TEST_CONFIG_PATH)).toEqual([]);
  });

  it('filters out entries with missing required fields', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      servers: [
        { name: 'valid', command: 'echo' },
        { name: '', command: 'echo' }, // empty name
        { name: 'no-command' },         // missing command
      ],
    }));

    const result = loadMCPConfig(TEST_CONFIG_PATH);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('valid');
  });
});

describe('saveMCPConfig', () => {
  it('creates directory and writes config', () => {
    const servers: MCPServerConfig[] = [
      { name: 'test', command: 'echo', args: ['hello'] },
    ];

    saveMCPConfig(servers, TEST_CONFIG_PATH);

    expect(fs.existsSync(TEST_CONFIG_PATH)).toBe(true);
    const loaded = loadMCPConfig(TEST_CONFIG_PATH);
    expect(loaded.length).toBe(1);
    expect(loaded[0].name).toBe('test');
  });

  it('overwrites existing config', () => {
    saveMCPConfig([{ name: 'first', command: 'a' }], TEST_CONFIG_PATH);
    saveMCPConfig([{ name: 'second', command: 'b' }], TEST_CONFIG_PATH);

    const loaded = loadMCPConfig(TEST_CONFIG_PATH);
    expect(loaded.length).toBe(1);
    expect(loaded[0].name).toBe('second');
  });
});

describe('hasMCPConfig', () => {
  it('returns false when no config exists', () => {
    expect(hasMCPConfig('/nonexistent/path/mcp.json')).toBe(false);
  });

  it('returns true when servers are configured', () => {
    saveMCPConfig([{ name: 'test', command: 'echo' }], TEST_CONFIG_PATH);
    expect(hasMCPConfig(TEST_CONFIG_PATH)).toBe(true);
  });

  it('returns false when servers array is empty', () => {
    saveMCPConfig([], TEST_CONFIG_PATH);
    expect(hasMCPConfig(TEST_CONFIG_PATH)).toBe(false);
  });
});
