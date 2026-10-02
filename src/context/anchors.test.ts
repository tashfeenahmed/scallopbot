import { describe, expect, it } from 'vitest';
import { ANCHOR_CAPS, extractAnchors, mergeAnchors, renderAnchors, emptyAnchors } from './anchors.js';

describe('extractAnchors', () => {
  const text = [
    'Pushed commit 3f9a2c1 and merged 0123456789abcdef0123456789abcdef01234567 into main (PR #482, fixes issue 77).',
    'See https://github.com/acme/repo/pull/482. and https://www.notion.so/ad20024aa8524c5bb340977aafee5acd?v=e954',
    'Edited src/agent/agent.ts, ./scripts/deploy.sh and README.md; config at ~/.config/app/settings.json',
    'Created page id: "2f45fd9b-8793-8100-8142-df35a6314d22" and goal ID: vTZ2Ztccv31GP87h36AuP',
    'TypeError: Cannot read properties of undefined (reading \'map\')',
    '  ✗ 3 tests FAILED in module.test.ts',
    'Contact evelyn@kilkennydesign.com for the intro.',
    'version 1.2.3 released on 2024/01/02',
  ].join('\n');
  const anchors = extractAnchors([text]);

  it('captures commit SHAs (short and full) but not plain words or uuids', () => {
    expect(anchors.commits).toContain('3f9a2c1');
    expect(anchors.commits).toContain('0123456789abcdef0123456789abcdef01234567');
    expect(anchors.commits.some(sha => sha.startsWith('2f45fd9b'))).toBe(false);
  });

  it('captures PR/issue numbers, URLs (trailing punctuation trimmed), paths and ids verbatim', () => {
    expect(anchors.refs).toEqual(expect.arrayContaining(['#482', '#77']));
    expect(anchors.urls).toContain('https://github.com/acme/repo/pull/482');
    expect(anchors.urls.some(url => url.startsWith('https://www.notion.so/ad20024aa8524c5bb340977aafee5acd'))).toBe(true);
    expect(anchors.files).toEqual(expect.arrayContaining(['src/agent/agent.ts', './scripts/deploy.sh', 'README.md', '~/.config/app/settings.json', 'module.test.ts']));
    expect(anchors.ids).toEqual(expect.arrayContaining(['2f45fd9b-8793-8100-8142-df35a6314d22', 'vTZ2Ztccv31GP87h36AuP']));
    expect(anchors.emails).toContain('evelyn@kilkennydesign.com');
  });

  it('captures error lines', () => {
    expect(anchors.errors.some(line => line.startsWith('TypeError: Cannot read properties'))).toBe(true);
    expect(anchors.errors.some(line => line.includes('3 tests FAILED'))).toBe(true);
    expect(anchors.errors.some(line => line.includes('version 1.2.3'))).toBe(false);
  });

  it('dedupes and caps each category, keeping the newest fragments first', () => {
    const fragments = Array.from({ length: 200 }, (_, index) => `touched src/file${index}.ts`);
    const capped = extractAnchors(fragments);
    expect(capped.files).toHaveLength(ANCHOR_CAPS.files);
    expect(capped.files[0]).toBe('src/file0.ts');
    expect(new Set(capped.files).size).toBe(capped.files.length);
  });

  it('stays fast on long opaque tool output', () => {
    const started = performance.now();
    extractAnchors(Array.from({ length: 50 }, () => 'x'.repeat(20_000)));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('merges newer before older and renders a compact block', () => {
    const merged = mergeAnchors({ ...emptyAnchors(), files: ['b.ts'] }, { ...emptyAnchors(), files: ['a.ts', 'b.ts'] });
    expect(merged.files).toEqual(['b.ts', 'a.ts']);
    expect(renderAnchors(merged)).toBe('- Files: b.ts · a.ts');
    expect(renderAnchors(emptyAnchors())).toBe('');
  });
});

describe('anchor salience and context', () => {
  it('ranks ids used in prose/tool inputs above one-off ids in tool output when the cap overflows', () => {
    const noise = Array.from({ length: 80 }, (_, index) => ({
      text: `{"request_id":"${index.toString(16).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd"}`, weight: 1,
    }));
    const used = { text: 'DB_ID="94387067-9158-4c07-a153-8d1152598da5" curl ...', weight: 3 };
    const anchors = extractAnchors([...noise, used]);
    expect(anchors.ids).toHaveLength(ANCHOR_CAPS.ids);
    expect(anchors.ids).toContain('94387067-9158-4c07-a153-8d1152598da5');
  });

  it('keeps a short verbatim context for ids so the model can tell them apart', () => {
    const anchors = extractAnchors([
      { text: '{"object":"database","id":"94387067-9158-4c07-a153-8d1152598da5","title":[{"type":"text","text":{"content":"Client Tracker v2"}}]}', weight: 1 },
      { text: 'DB_ID="94387067-9158-4c07-a153-8d1152598da5"\n# add the 5 entries', weight: 3 },
    ]);
    const context = anchors.context?.['94387067-9158-4c07-a153-8d1152598da5'] ?? '';
    expect(context).toContain('Client Tracker v2');
    expect(context).toContain('add the 5 entries');
    expect(renderAnchors(anchors)).toContain('  - 94387067-9158-4c07-a153-8d1152598da5 — ');
  });

  it('captures ISO dates / date-like versions but not timestamps', () => {
    const anchors = extractAnchors(['-H "Notion-Version: 2025-09-03"', '"created_time":"2026-02-17T12:43:44.724+00:00"']);
    expect(anchors.dates).toEqual(['2025-09-03']);
  });
});
