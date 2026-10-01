/**
 * Image generation providers for the image_gen skill.
 *
 * Plain fetch against each vendor's HTTP API (no SDKs). `fetch` is injected so
 * tests never touch the network. Every call returns the image bytes plus the
 * dollar cost it incurred, which the handler records in the cost tracker.
 */

export type ImageProviderName = 'openai' | 'fal' | 'openrouter';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ImageRequest {
  prompt: string;
  /** Source image for an edit; undefined means text-to-image. */
  image?: { data: Buffer; mimeType: string; fileName: string };
  size?: string;
  quality?: 'low' | 'medium' | 'high';
}

export interface ImageResult {
  data: Buffer;
  mimeType: string;
  provider: ImageProviderName;
  model: string;
  costUsd: number;
}

export interface ImageProviderConfig {
  name: ImageProviderName;
  apiKey: string;
  model: string;
  editModel: string;
}

const PROVIDER_ORDER: ImageProviderName[] = ['openai', 'fal', 'openrouter'];

const KEY_ENV: Record<ImageProviderName, string> = {
  openai: 'OPENAI_API_KEY',
  fal: 'FAL_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const DEFAULT_MODELS: Record<ImageProviderName, { model: string; editModel: string }> = {
  openai: { model: 'gpt-image-1', editModel: 'gpt-image-1' },
  fal: { model: 'fal-ai/flux/schnell', editModel: 'fal-ai/flux-pro/kontext' },
  openrouter: { model: 'google/gemini-2.5-flash-image', editModel: 'google/gemini-2.5-flash-image' },
};

/** Env keys any provider needs; used for subprocess env and availability. */
export const IMAGE_PROVIDER_ENV_KEYS = Object.values(KEY_ENV);

/**
 * Pick a provider: IMAGE_GEN_PROVIDER when set (and its key exists), else the
 * first provider in openai → fal → openrouter order with a key configured.
 */
export function selectImageProvider(env: Record<string, string | undefined> = process.env): ImageProviderConfig | { error: string } {
  const requested = env.IMAGE_GEN_PROVIDER?.trim().toLowerCase();
  let name: ImageProviderName | undefined;
  if (requested) {
    if (!PROVIDER_ORDER.includes(requested as ImageProviderName)) {
      return { error: `IMAGE_GEN_PROVIDER="${requested}" is not supported (use openai, fal or openrouter)` };
    }
    name = requested as ImageProviderName;
    if (!env[KEY_ENV[name]]) {
      return { error: `IMAGE_GEN_PROVIDER=${name} but ${KEY_ENV[name]} is not set` };
    }
  } else {
    name = PROVIDER_ORDER.find(p => !!env[KEY_ENV[p]]);
  }
  if (!name) {
    return { error: 'No image provider configured. Set OPENAI_API_KEY, FAL_KEY or OPENROUTER_API_KEY.' };
  }
  const model = env.IMAGE_GEN_MODEL?.trim() || DEFAULT_MODELS[name].model;
  return {
    name,
    apiKey: env[KEY_ENV[name]]!,
    model,
    editModel: env.IMAGE_GEN_EDIT_MODEL?.trim() || (env.IMAGE_GEN_MODEL?.trim() ? model : DEFAULT_MODELS[name].editModel),
  };
}

// ---------------------------------------------------------------------------
// Price estimates (USD per image). Used for the budget pre-check and as the
// recorded cost when the API does not report usage. IMAGE_GEN_COST_USD
// overrides the estimate for models not listed here.
// ---------------------------------------------------------------------------

const OPENAI_PER_IMAGE: Record<string, Record<'low' | 'medium' | 'high', number>> = {
  'gpt-image-1': { low: 0.011, medium: 0.042, high: 0.167 },
  'gpt-image-1-mini': { low: 0.005, medium: 0.011, high: 0.036 },
};

const FAL_PER_IMAGE: Record<string, number> = {
  'fal-ai/flux/schnell': 0.003,
  'fal-ai/flux/dev': 0.025,
  'fal-ai/flux-pro/kontext': 0.04,
};

const OPENROUTER_PER_IMAGE_FALLBACK = 0.04;

export function estimateImageCost(
  config: Pick<ImageProviderConfig, 'name'>,
  model: string,
  quality: 'low' | 'medium' | 'high' = 'medium',
  env: Record<string, string | undefined> = process.env,
): number {
  const override = Number(env.IMAGE_GEN_COST_USD);
  if (Number.isFinite(override) && override > 0) return override;
  if (config.name === 'openai') return (OPENAI_PER_IMAGE[model] ?? OPENAI_PER_IMAGE['gpt-image-1'])[quality];
  if (config.name === 'fal') return FAL_PER_IMAGE[model] ?? 0.04;
  return OPENROUTER_PER_IMAGE_FALLBACK;
}

/** gpt-image-1 bills tokens: text in $5/M, image in $10/M, image out $40/M. */
function openAiUsageCost(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as {
    output_tokens?: number;
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  };
  if (typeof u.output_tokens !== 'number') return null;
  const text = u.input_tokens_details?.text_tokens ?? 0;
  const image = u.input_tokens_details?.image_tokens ?? 0;
  return (text * 5 + image * 10 + u.output_tokens * 40) / 1_000_000;
}

async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  return `${res.status} ${body.slice(0, 300)}`.trim();
}

function decodeDataUrl(url: string): { data: Buffer; mimeType: string } | null {
  const match = url.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!match) return null;
  return { mimeType: match[1], data: Buffer.from(match[2], 'base64') };
}

async function download(fetchFn: FetchLike, url: string): Promise<{ data: Buffer; mimeType: string }> {
  const inline = decodeDataUrl(url);
  if (inline) return inline;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Image download failed: ${await readError(res)}`);
  const mimeType = res.headers.get('content-type')?.split(';')[0] || 'image/png';
  return { data: Buffer.from(await res.arrayBuffer()), mimeType };
}

function toDataUrl(image: NonNullable<ImageRequest['image']>): string {
  return `data:${image.mimeType};base64,${image.data.toString('base64')}`;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async function openAiImage(config: ImageProviderConfig, req: ImageRequest, fetchFn: FetchLike): Promise<ImageResult> {
  const quality = req.quality ?? 'medium';
  const size = req.size ?? '1024x1024';
  const headers = { Authorization: `Bearer ${config.apiKey}` };
  let res: Response;
  let model: string;
  if (req.image) {
    model = config.editModel;
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', req.prompt);
    form.append('size', size);
    form.append('quality', quality);
    form.append('image', new Blob([new Uint8Array(req.image.data)], { type: req.image.mimeType }), req.image.fileName);
    res = await fetchFn('https://api.openai.com/v1/images/edits', { method: 'POST', headers, body: form });
  } else {
    model = config.model;
    res = await fetchFn('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: req.prompt, size, quality, n: 1 }),
    });
  }
  if (!res.ok) throw new Error(`OpenAI Images error: ${await readError(res)}`);
  const json = await res.json() as { data?: Array<{ b64_json?: string; url?: string }>; usage?: unknown };
  const first = json.data?.[0];
  let image: { data: Buffer; mimeType: string };
  if (first?.b64_json) image = { data: Buffer.from(first.b64_json, 'base64'), mimeType: 'image/png' };
  else if (first?.url) image = await download(fetchFn, first.url);
  else throw new Error('OpenAI Images returned no image');
  const costUsd = openAiUsageCost(json.usage) ?? estimateImageCost(config, model, quality);
  return { ...image, provider: 'openai', model, costUsd };
}

const FAL_SIZES: Record<string, string> = {
  '1024x1024': 'square_hd',
  '1536x1024': 'landscape_4_3',
  '1024x1536': 'portrait_4_3',
};

async function falImage(config: ImageProviderConfig, req: ImageRequest, fetchFn: FetchLike): Promise<ImageResult> {
  const model = req.image ? config.editModel : config.model;
  const body: Record<string, unknown> = { prompt: req.prompt, num_images: 1 };
  if (req.image) body.image_url = toDataUrl(req.image);
  else body.image_size = FAL_SIZES[req.size ?? '1024x1024'] ?? 'square_hd';
  const res = await fetchFn(`https://fal.run/${model}`, {
    method: 'POST',
    headers: { Authorization: `Key ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`FAL error: ${await readError(res)}`);
  const json = await res.json() as { images?: Array<{ url?: string; content_type?: string }> };
  const url = json.images?.[0]?.url;
  if (!url) throw new Error('FAL returned no image');
  const image = await download(fetchFn, url);
  return { ...image, provider: 'fal', model, costUsd: estimateImageCost(config, model) };
}

async function openRouterImage(config: ImageProviderConfig, req: ImageRequest, fetchFn: FetchLike): Promise<ImageResult> {
  const model = req.image ? config.editModel : config.model;
  const content: unknown = req.image
    ? [
        { type: 'text', text: req.prompt },
        { type: 'image_url', image_url: { url: toDataUrl(req.image) } },
      ]
    : req.prompt;
  const res = await fetchFn('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      modalities: ['image', 'text'],
      messages: [{ role: 'user', content }],
      usage: { include: true },
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter error: ${await readError(res)}`);
  const json = await res.json() as {
    choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
    usage?: { cost?: number };
  };
  const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) throw new Error(`OpenRouter model ${model} returned no image (is it image-capable?)`);
  const image = await download(fetchFn, url);
  const reported = json.usage?.cost;
  const costUsd = typeof reported === 'number' && reported >= 0 ? reported : estimateImageCost(config, model);
  return { ...image, provider: 'openrouter', model, costUsd };
}

export async function generateImage(
  config: ImageProviderConfig,
  req: ImageRequest,
  fetchFn: FetchLike = fetch,
): Promise<ImageResult> {
  switch (config.name) {
    case 'openai': return openAiImage(config, req, fetchFn);
    case 'fal': return falImage(config, req, fetchFn);
    case 'openrouter': return openRouterImage(config, req, fetchFn);
  }
}

export function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'png';
}

export function mimeForPath(filePath: string): string | null {
  const ext = filePath.toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return null;
}
