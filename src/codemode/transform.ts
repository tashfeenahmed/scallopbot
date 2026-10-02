/**
 * Cell transform for the code-mode kernel.
 *
 * A cell is arbitrary JavaScript the model wrote. We run it as a classic
 * script (so V8 gives `<cell-N>` filenames and real line numbers) wrapped in
 * an async arrow IIFE (so top-level `await` works). Wrapping alone would make
 * every top-level declaration local to that one cell, so the transform hoists
 * them onto the global object:
 *
 *   const a = 1            →  ;(a = 1)             (+ `var a;` in the prelude)
 *   let {b, c: [d]} = o    →  ;({b, c: [d]} = o)
 *   var e                  →  ;void 0  (keeps the old value, like var)
 *   function f() {}        →  kept in place, `globalThis.f = f` at body start
 *   class C {}             →  ;C = class C {};
 *   import x from 'm'      →  x = (await __cm_import("m")).default
 *   last expression `x`    →  return {__v: (x)}
 *
 * The prelude and the IIFE opener sit on line 1 without a newline, so every
 * user line keeps its number; column shifts are returned in `shifts` (the
 * worker maps traceback columns back with them).
 * Redeclaring a name in a later cell is allowed (REPL semantics): const-ness
 * is not preserved across cells.
 */

import * as acorn from 'acorn';

export interface TransformResult {
  /** Script source ready for vm.Script. */
  code: string;
  /** Characters inserted before the user's first line (line-1 column shift). */
  prefixLength: number;
  /** Names the cell declares at top level (now globals). */
  declared: string[];
  /** Top-level names bound to a function/class written in this cell. */
  functionNames: string[];
  /** True when the cell ends with an expression whose value is reported. */
  hasValue: boolean;
  /**
   * Column shifts introduced by the rewrite, for mapping stack positions back
   * to the user's source: [line (1-based), original column (0-based),
   * inserted chars, removed chars]. Line numbers never change.
   */
  shifts: Array<[number, number, number, number]>;
}


export class CellSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = 'SyntaxError';
  }
}

type Node = acorn.Node & Record<string, any>;

interface Edit {
  start: number;
  end: number;
  text: string;
}

const PARSE_BASE: acorn.Options = {
  ecmaVersion: 'latest',
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowHashBang: true,
  locations: true,
};

function parse(code: string): Node {
  try {
    return acorn.parse(code, { ...PARSE_BASE, sourceType: 'script' }) as Node;
  } catch (scriptError) {
    // `import x from 'y'` is only legal in module goal. Module goal is strict,
    // so prefer the script parse and use this only as a fallback.
    try {
      return acorn.parse(code, { ...PARSE_BASE, sourceType: 'module' }) as Node;
    } catch {
      const err = scriptError as Error & { loc?: { line: number; column: number } };
      const message = err.message.replace(/\s*\(\d+:\d+\)$/, '');
      throw new CellSyntaxError(message, err.loc?.line ?? 1, err.loc?.column ?? 0);
    }
  }
}

/** Collect binding names from a declaration pattern. */
export function patternNames(pattern: Node | null | undefined, out: string[] = []): string[] {
  if (!pattern) return out;
  switch (pattern.type) {
    case 'Identifier':
      out.push(pattern.name);
      break;
    case 'ObjectPattern':
      for (const prop of pattern.properties as Node[]) {
        if (prop.type === 'RestElement') patternNames(prop.argument, out);
        else patternNames(prop.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const element of pattern.elements as Array<Node | null>) patternNames(element, out);
      break;
    case 'AssignmentPattern':
      patternNames(pattern.left, out);
      break;
    case 'RestElement':
      patternNames(pattern.argument, out);
      break;
    default:
      break;
  }
  return out;
}

/** Visit every node (no scope analysis needed: we only look for ImportExpression). */
function walk(node: unknown, visit: (n: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as Node;
  if (typeof n.type !== 'string') return;
  visit(n);
  for (const key of Object.keys(n)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
    const value = n[key];
    if (value && typeof value === 'object') walk(value, visit);
  }
}

const FUNCTION_INIT = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression']);

export function transformCell(code: string): TransformResult {
  const program = parse(code);
  const body = program.body as Node[];
  const edits: Edit[] = [];
  const declared = new Set<string>();
  const functionNames = new Set<string>();
  const functionExports: string[] = [];
  let importCounter = 0;

  const transformDeclaration = (stmt: Node, start: number) => {
    if (stmt.type === 'VariableDeclaration') {
      const declarators = stmt.declarations as Node[];
      // `const ` (or `export const `) → `;` — the leading semicolon keeps a
      // previous ASI-terminated line from swallowing our parenthesis.
      edits.push({ start, end: declarators[0].start, text: ';' });
      for (const declarator of declarators) {
        const names = patternNames(declarator.id);
        names.forEach(name => declared.add(name));
        if (declarator.id.type === 'Identifier' && declarator.init && FUNCTION_INIT.has(declarator.init.type)) {
          functionNames.add(declarator.id.name);
        }
        if (declarator.init) {
          edits.push({ start: declarator.start, end: declarator.start, text: '(' });
          edits.push({ start: declarator.end, end: declarator.end, text: ')' });
        } else if (stmt.kind === 'var') {
          edits.push({ start: declarator.start, end: declarator.end, text: 'void 0' });
        } else {
          // let x;  → a fresh binding starts undefined
          edits.push({ start: declarator.start, end: declarator.end, text: `(${names.map(n => `${n} = undefined`).join(', ')})` });
        }
      }
      return;
    }
    if (stmt.type === 'FunctionDeclaration' && stmt.id) {
      declared.add(stmt.id.name);
      functionNames.add(stmt.id.name);
      functionExports.push(stmt.id.name);
      if (start !== stmt.start) edits.push({ start, end: stmt.start, text: '' });
      return;
    }
    if (stmt.type === 'ClassDeclaration' && stmt.id) {
      declared.add(stmt.id.name);
      functionNames.add(stmt.id.name);
      edits.push({ start, end: stmt.start, text: `;${stmt.id.name} = ` });
      edits.push({ start: stmt.end, end: stmt.end, text: ';' });
    }
  };

  for (const stmt of body) {
    if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
      transformDeclaration(stmt.declaration, stmt.start);
    } else if (stmt.type === 'ExportDefaultDeclaration' || (stmt.type === 'ExportNamedDeclaration' && !stmt.declaration) || stmt.type === 'ExportAllDeclaration') {
      throw new CellSyntaxError('export is not supported in a kernel cell; assign to a variable instead', stmt.loc!.start.line, stmt.loc!.start.column);
    } else if (stmt.type === 'ImportDeclaration') {
      const tmp = `__cm_m${importCounter++}`;
      const parts = [`const ${tmp} = await __cm_import(${JSON.stringify(stmt.source.value)});`];
      for (const spec of stmt.specifiers as Node[]) {
        const local = spec.local.name as string;
        declared.add(local);
        if (spec.type === 'ImportDefaultSpecifier') parts.push(`${local} = ${tmp}.default;`);
        else if (spec.type === 'ImportNamespaceSpecifier') parts.push(`${local} = ${tmp};`);
        else {
          const imported = spec.imported.type === 'Identifier' ? spec.imported.name : String(spec.imported.value);
          parts.push(`${local} = ${tmp}[${JSON.stringify(imported)}];`);
        }
      }
      edits.push({ start: stmt.start, end: stmt.end, text: parts.join(' ') });
    } else {
      transformDeclaration(stmt, stmt.start);
    }
  }

  // Dynamic import() must go through the kernel's resolver (relative to the
  // workspace, not to the anonymous script).
  walk(program, node => {
    if (node.type === 'ImportExpression') {
      edits.push({ start: node.start, end: node.start + 'import'.length, text: '__cm_import' });
    }
  });

  let hasValue = false;
  const last = body[body.length - 1];
  if (last && last.type === 'ExpressionStatement' && !(typeof last.directive === 'string' && /^use /.test(last.directive))) {
    hasValue = true;
    edits.push({ start: last.start, end: last.expression.start, text: 'return {__v: (' });
    edits.push({ start: last.expression.end, end: last.expression.end, text: ')};' });
    if (last.end > last.expression.end) {
      // Drop the original trailing semicolon (we already closed the statement).
      edits.push({ start: last.expression.end, end: last.end, text: '' });
    }
  }

  const { text: output, shifts } = applyEdits(code, edits);

  const names = [...declared];
  const prelude = names.length > 0 ? `var ${names.join(', ')};` : '';
  const exportsCode = functionExports.map(name => `globalThis[${JSON.stringify(name)}] = ${name};`).join('');
  const prefix = `${prelude}(async () => {${exportsCode}`;
  return {
    code: `${prefix}${output}\n})()`,
    prefixLength: prefix.length,
    declared: names,
    functionNames: [...functionNames],
    hasValue,
    shifts: [[1, 0, prefix.length, 0] as [number, number, number, number], ...shifts]
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || b[2] - a[2]),
  };
}

/**
 * Apply non-overlapping edits (zero-width inserts allowed at range
 * boundaries). Newlines inside a replaced range are kept so every user line
 * keeps its number; column shifts are recorded for traceback mapping.
 */
function applyEdits(code: string, edits: Edit[]): { text: string; shifts: Array<[number, number, number, number]> } {
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
  const position = (offset: number): [number, number] => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return [lo + 1, offset - lineStarts[lo]];
  };

  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const shifts: Array<[number, number, number, number]> = [];
  let out = '';
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start < cursor) throw new Error(`internal transform error: overlapping edit at ${edit.start}`);
    const removed = code.slice(edit.start, edit.end);
    const newlineAt = removed.indexOf('\n');
    const newlines = newlineAt >= 0 ? '\n'.repeat(removed.split('\n').length - 1) : '';
    out += code.slice(cursor, edit.start) + edit.text + newlines;
    const [line, column] = position(edit.start);
    const removedOnLine = newlineAt >= 0 ? newlineAt : removed.length;
    if (edit.text.length !== removedOnLine) shifts.push([line, column, edit.text.length, removedOnLine]);
    cursor = edit.end;
  }
  return { text: out + code.slice(cursor), shifts };
}
