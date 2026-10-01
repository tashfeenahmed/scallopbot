import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { CostTracker } from '../../../../routing/cost.js';
import { createImageGenHandler } from './handler.js';
import { selectImageProvider, estimateImageCost } from './providers.js';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('selectImageProvider', () => {
  it('prefers IMAGE_GEN_PROVIDER when its key is set', () => {
    const picked = selectImageProvider({ IMAGE_GEN_PROVIDER: 'fal', FAL_KEY: 'f', OPENAI_API_KEY: 'o' });
    expect(picked).toMatchObject({ name: 'fal', apiKey: 'f', model: 'fal-ai/flux/schnell', editModel: 'fal-ai/flux-pro/kontext' });
  });

  it('falls back to the first configured provider (openai, fal, openrouter)', () => {
    expect(selectImageProvider({ OPENROUTER_API_KEY: 'r', FAL_KEY: 'f' })).toMatchObject({ name: 'fal' });
    expect(selectImageProvider({ OPENROUTER_API_KEY: 'r' })).toMatchObject({ name: 'openrouter', model: 'google/gemini-2.5-flash-image' });
    expect(selectImageProvider({ OPENAI_API_KEY: 'o', OPENROUTER_API_KEY: 'r' })).toMatchObject({ name: 'openai', model: 'gpt-image-1' });
  });

  it('reports a missing key or unknown provider instead of guessing', () => {
    expect(selectImageProvider({})).toHaveProperty('error');
    expect(selectImageProvider({ IMAGE_GEN_PROVIDER: 'fal', OPENAI_API_KEY: 'o' })).toEqual({ error: expect.stringContaining('FAL_KEY') });
    expect(selectImageProvider({ IMAGE_GEN_PROVIDER: 'midjourney', OPENAI_API_KEY: 'o' })).toEqual({ error: expect.stringContaining('not supported') });
  });

  it('honours IMAGE_GEN_MODEL and IMAGE_GEN_COST_USD', () => {
    const picked = selectImageProvider({ OPENAI_API_KEY: 'o', IMAGE_GEN_MODEL: 'gpt-image-1-mini' });
    expect(picked).toMatchObject({ model: 'gpt-image-1-mini', editModel: 'gpt-image-1-mini' });
    expect(estimateImageCost({ name: 'openai' }, 'gpt-image-1-mini', 'low', {})).toBe(0.005);
    expect(estimateImageCost({ name: 'fal' }, 'x', 'medium', { IMAGE_GEN_COST_USD: '0.5' })).toBe(0.5);
  });
});

describe('image_gen handler', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'image-gen-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  const ctx = (args: Record<string, unknown>) => ({
    args,
    workspace,
    sessionId: 'sess-1',
    userId: 'telegram:42',
    userMessage: 'draw a cat',
  });

  it('generates with OpenAI, saves under output/, delivers, and records the cost', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: [{ b64_json: PNG_BYTES.toString('base64') }],
      usage: { input_tokens: 10, output_tokens: 1056, input_tokens_details: { text_tokens: 10, image_tokens: 0 } },
    }));
    const tracker = new CostTracker({ dailyBudget: 5 });
    const deliverFile = vi.fn().mockResolvedValue(true);
    const handler = createImageGenHandler({
      costTracker: tracker,
      deliverFile,
      fetch: fetchMock,
      env: { OPENAI_API_KEY: 'sk-test' },
      now: () => 1700000000000,
    });

    const result = await handler(ctx({ prompt: 'A cat in a hat', caption: 'Here you go' }));

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/images/generations');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body)).toMatchObject({ model: 'gpt-image-1', prompt: 'A cat in a hat', size: '1024x1024', quality: 'medium', n: 1 });

    const saved = path.join(workspace, 'output', 'image-1700000000000-a-cat-in-a-hat.png');
    expect(await readFile(saved)).toEqual(PNG_BYTES);
    expect(deliverFile).toHaveBeenCalledWith('telegram:42', saved, 'Here you go', expect.objectContaining({ sessionId: 'sess-1' }));
    expect(result.output).toContain('"delivered":true');

    // 10 text tokens * $5/M + 1056 output tokens * $40/M
    const expected = (10 * 5 + 1056 * 40) / 1_000_000;
    expect(tracker.getDailySpend()).toBeCloseTo(expected, 8);
    expect(tracker.getUsageHistory()[0]).toMatchObject({ provider: 'image:openai', model: 'gpt-image-1', sessionId: 'sess-1' });
  });

  it('refuses without calling the provider when the daily budget is used up', async () => {
    const tracker = new CostTracker({ dailyBudget: 1 });
    tracker.recordFlatCost({ model: 'x', provider: 'test', sessionId: 's', cost: 1 });
    const fetchMock = vi.fn();
    const handler = createImageGenHandler({ costTracker: tracker, fetch: fetchMock, env: { OPENAI_API_KEY: 'k' } });

    const result = await handler(ctx({ prompt: 'anything' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('BUDGET_EXCEEDED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses when this image would push spend past the monthly budget', async () => {
    const tracker = new CostTracker({ monthlyBudget: 1 });
    tracker.recordFlatCost({ model: 'x', provider: 'test', sessionId: 's', cost: 0.99 });
    const fetchMock = vi.fn();
    const handler = createImageGenHandler({ costTracker: tracker, fetch: fetchMock, env: { OPENAI_API_KEY: 'k' } });

    const result = await handler(ctx({ prompt: 'anything', quality: 'high' }));

    expect(result.error).toContain('Monthly budget would be exceeded');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses FAL with its own auth header and downloads the hosted image', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ images: [{ url: 'https://fal.media/files/x.jpg', content_type: 'image/jpeg' }] }))
      .mockResolvedValueOnce(new Response(PNG_BYTES, { headers: { 'Content-Type': 'image/jpeg' } }));
    const tracker = new CostTracker({});
    const handler = createImageGenHandler({ costTracker: tracker, fetch: fetchMock, env: { FAL_KEY: 'fal-key' }, now: () => 1 });

    const result = await handler(ctx({ prompt: 'mountains', size: '1536x1024', deliver: false }));

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://fal.run/fal-ai/flux/schnell');
    expect(init.headers.Authorization).toBe('Key fal-key');
    expect(JSON.parse(init.body)).toEqual({ prompt: 'mountains', num_images: 1, image_size: 'landscape_4_3' });
    expect(fetchMock.mock.calls[1][0]).toBe('https://fal.media/files/x.jpg');
    expect(await readFile(path.join(workspace, 'output', 'image-1-mountains.jpg'))).toEqual(PNG_BYTES);
    expect(tracker.getDailySpend()).toBeCloseTo(0.003, 8);
    expect(result.output).toContain('Saved only');
  });

  it('edits an image in the workspace through OpenRouter and records the reported cost', async () => {
    await mkdir(path.join(workspace, 'output'), { recursive: true });
    await writeFile(path.join(workspace, 'output', 'user-photo.png'), PNG_BYTES);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      choices: [{ message: { images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` } }] } }],
      usage: { cost: 0.0391 },
    }));
    const tracker = new CostTracker({});
    const deliverFile = vi.fn().mockResolvedValue(true);
    const handler = createImageGenHandler({ costTracker: tracker, deliverFile, fetch: fetchMock, env: { OPENROUTER_API_KEY: 'or' } });

    const result = await handler(ctx({ prompt: 'make it watercolor', image_path: 'output/user-photo.png' }));

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.modalities).toEqual(['image', 'text']);
    expect(body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(tracker.getDailySpend()).toBeCloseTo(0.0391, 8);
    expect(deliverFile).toHaveBeenCalledOnce();
  });

  it('sends OpenAI edits as multipart with the source image', async () => {
    await writeFile(path.join(workspace, 'in.jpg'), PNG_BYTES);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }));
    const handler = createImageGenHandler({ fetch: fetchMock, env: { OPENAI_API_KEY: 'k' } });

    const result = await handler(ctx({ prompt: 'add a hat', image_path: path.join(workspace, 'in.jpg') }));

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/images/edits');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('gpt-image-1');
    expect(form.get('prompt')).toBe('add a hat');
    expect((form.get('image') as File).type).toBe('image/jpeg');
  });

  it('rejects image_path outside the workspace', async () => {
    const fetchMock = vi.fn();
    const handler = createImageGenHandler({ fetch: fetchMock, env: { OPENAI_API_KEY: 'k' } });
    const result = await handler(ctx({ prompt: 'x', image_path: '/etc/hosts' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('inside the workspace');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records the spend even when delivery fails, and tells the model to retry with send_file', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ b64_json: PNG_BYTES.toString('base64') }] }));
    const tracker = new CostTracker({});
    const handler = createImageGenHandler({
      costTracker: tracker,
      deliverFile: vi.fn().mockResolvedValue(false),
      fetch: fetchMock,
      env: { OPENAI_API_KEY: 'k' },
    });
    const result = await handler(ctx({ prompt: 'x' }));
    expect(result.success).toBe(true);
    expect(result.output).toContain('call send_file');
    expect(tracker.getDailySpend()).toBeCloseTo(0.042, 8);
  });

  it('surfaces provider errors without recording spend', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":{"message":"bad prompt"}}', { status: 400 }));
    const tracker = new CostTracker({});
    const handler = createImageGenHandler({ costTracker: tracker, fetch: fetchMock, env: { OPENAI_API_KEY: 'k' } });
    const result = await handler(ctx({ prompt: 'x' }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('OpenAI Images error: 400');
    expect(tracker.getDailySpend()).toBe(0);
  });
});
