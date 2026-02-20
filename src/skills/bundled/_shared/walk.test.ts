import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { walk, parseGitignore, isIgnored, globToRegex, isBinaryFile } from './walk.js';

describe('walk utilities', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('parseGitignore', () => {
    it('should parse basic patterns', () => {
      const rules = parseGitignore('*.log\nbuild/\n# comment\n\n.env');
      expect(rules).toHaveLength(3);
    });

    it('should handle negated patterns', () => {
      const rules = parseGitignore('*.log\n!important.log');
      expect(rules).toHaveLength(2);
      expect(rules[1].negated).toBe(true);
    });

    it('should skip empty lines and comments', () => {
      const rules = parseGitignore('# comment\n\n  \n*.log');
      expect(rules).toHaveLength(1);
    });
  });

  describe('isIgnored', () => {
    it('should match simple file patterns', () => {
      const rules = parseGitignore('*.log');
      expect(isIgnored('app.log', rules)).toBe(true);
      expect(isIgnored('app.ts', rules)).toBe(false);
    });

    it('should match directory patterns', () => {
      const rules = parseGitignore('build/');
      expect(isIgnored('build', rules)).toBe(true);
      expect(isIgnored('build/output.js', rules)).toBe(true);
    });

    it('should respect negation', () => {
      const rules = parseGitignore('*.log\n!important.log');
      expect(isIgnored('app.log', rules)).toBe(true);
      expect(isIgnored('important.log', rules)).toBe(false);
    });
  });

  describe('globToRegex', () => {
    it('should match single star', () => {
      const re = globToRegex('*.ts');
      expect(re.test('index.ts')).toBe(true);
      expect(re.test('src/index.ts')).toBe(false);
    });

    it('should match double star', () => {
      const re = globToRegex('**/*.ts');
      expect(re.test('index.ts')).toBe(true);
      expect(re.test('src/index.ts')).toBe(true);
      expect(re.test('src/deep/index.ts')).toBe(true);
    });

    it('should match question mark', () => {
      const re = globToRegex('?.ts');
      expect(re.test('a.ts')).toBe(true);
      expect(re.test('ab.ts')).toBe(false);
    });

    it('should match brace alternatives', () => {
      const re = globToRegex('*.{ts,js}');
      expect(re.test('index.ts')).toBe(true);
      expect(re.test('index.js')).toBe(true);
      expect(re.test('index.py')).toBe(false);
    });
  });

  describe('isBinaryFile', () => {
    it('should detect text files', () => {
      const filePath = path.join(tmpDir, 'text.txt');
      fs.writeFileSync(filePath, 'Hello world\n');
      expect(isBinaryFile(filePath)).toBe(false);
    });

    it('should detect binary files', () => {
      const filePath = path.join(tmpDir, 'binary.bin');
      const buf = Buffer.alloc(100);
      buf[50] = 0; // null byte
      buf.write('some text', 0);
      fs.writeFileSync(filePath, buf);
      expect(isBinaryFile(filePath)).toBe(true);
    });

    it('should return false for missing files', () => {
      expect(isBinaryFile(path.join(tmpDir, 'nope.bin'))).toBe(false);
    });
  });

  describe('walk', () => {
    it('should yield files in directory', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'const a = 1;');
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), 'const b = 2;');

      const files: string[] = [];
      for await (const f of walk({ root: tmpDir })) {
        files.push(f);
      }
      expect(files.sort()).toEqual(['a.ts', 'b.ts']);
    });

    it('should skip .git and node_modules', async () => {
      fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.git', 'config'), 'data');
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), 'data');
      fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'ok');

      const files: string[] = [];
      for await (const f of walk({ root: tmpDir })) {
        files.push(f);
      }
      expect(files).toEqual(['index.ts']);
    });

    it('should respect .gitignore', async () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), '*.log\ndist/\n');
      fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'code');
      fs.writeFileSync(path.join(tmpDir, 'app.log'), 'log data');
      fs.mkdirSync(path.join(tmpDir, 'dist'));
      fs.writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), 'bundle');

      const files: string[] = [];
      for await (const f of walk({ root: tmpDir })) {
        files.push(f);
      }
      expect(files.sort()).toEqual(['.gitignore', 'app.ts']);
    });

    it('should apply glob pattern filter', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'ts');
      fs.writeFileSync(path.join(tmpDir, 'b.js'), 'js');
      fs.writeFileSync(path.join(tmpDir, 'c.py'), 'py');

      const files: string[] = [];
      for await (const f of walk({ root: tmpDir, globPattern: '*.ts' })) {
        files.push(f);
      }
      expect(files).toEqual(['a.ts']);
    });

    it('should respect maxFiles', async () => {
      for (let i = 0; i < 10; i++) {
        fs.writeFileSync(path.join(tmpDir, `file${i}.ts`), `${i}`);
      }

      const files: string[] = [];
      for await (const f of walk({ root: tmpDir, maxFiles: 3 })) {
        files.push(f);
      }
      expect(files).toHaveLength(3);
    });

    it('should walk nested directories', async () => {
      fs.mkdirSync(path.join(tmpDir, 'src', 'lib'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'src', 'index.ts'), 'root');
      fs.writeFileSync(path.join(tmpDir, 'src', 'lib', 'util.ts'), 'util');

      const files: string[] = [];
      for await (const f of walk({ root: tmpDir })) {
        files.push(f);
      }
      expect(files.sort()).toEqual([
        path.join('src', 'index.ts'),
        path.join('src', 'lib', 'util.ts'),
      ]);
    });
  });
});
