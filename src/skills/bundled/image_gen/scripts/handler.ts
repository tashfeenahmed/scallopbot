/**
 * In-process handler for the image_gen skill.
 *
 * Runs inside the gateway (not as a subprocess) because it needs the live
 * cost tracker, to refuse when the budget is exhausted and to record what the
 * image cost, and the active channel, to deliver the picture to the user.
 */

import { mkdir, readFile, realpath, stat, writeFile } from 'fs/promises';
import * as path from 'path';
import type { SkillHandlerContext, SkillHandlerFn } from '../../../types.js';
import { isWithin } from '../../_shared/pathguard.js';
import {
  estimateImageCost,
  extensionForMime,
  generateImage,
  mimeForPath,
  selectImageProvider,
  type FetchLike,
  type ImageRequest,
} from './providers.js';

/** The slice of CostTracker the handler needs (keeps tests light). */
export interface ImageCostLedger {
  canAfford(estimatedCost: number): { allowed: boolean; reason?: string };
  recordFlatCost(params: { model: string; provider: string; sessionId: string; cost: number }): void;
}

export interface ImageGenDeps {
  costTracker?: ImageCostLedger;
  /** Deliver a file on the user's current channel (Telegram photo, web file message). */
  deliverFile?: (userId: string, filePath: string, caption: string | undefined, ctx: SkillHandlerContext) => Promise<boolean>;
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const SIZES = new Set(['1024x1024', '1536x1024', '1024x1536']);
const QUALITIES = new Set(['low', 'medium', 'high']);

function slug(prompt: string): string {
  return prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
}

async function loadSourceImage(workspace: string, requested: string): Promise<ImageRequest['image'] | string> {
  const absolute = path.resolve(workspace, requested);
  if (!isWithin(workspace, absolute)) return 'image_path must be inside the workspace';
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return `image_path not found: ${requested}`;
  }
  if (!isWithin(await realpath(workspace), real)) return 'image_path must be inside the workspace';
  const mimeType = mimeForPath(real);
  if (!mimeType) return 'image_path must be a .png, .jpg or .webp file';
  const info = await stat(real);
  if (!info.isFile()) return `image_path is not a file: ${requested}`;
  if (info.size > MAX_SOURCE_BYTES) return 'image_path is larger than 20MB';
  return { data: await readFile(real), mimeType, fileName: path.basename(real) };
}

export function createImageGenHandler(deps: ImageGenDeps = {}): SkillHandlerFn {
  return async (ctx) => {
    const env = deps.env ?? process.env;
    const prompt = typeof ctx.args.prompt === 'string' ? ctx.args.prompt.trim() : '';
    if (!prompt) return { success: false, output: '', error: 'Missing required parameter: prompt' };

    const provider = selectImageProvider(env);
    if ('error' in provider) return { success: false, output: '', error: provider.error };

    const size = typeof ctx.args.size === 'string' && SIZES.has(ctx.args.size) ? ctx.args.size : '1024x1024';
    const quality = typeof ctx.args.quality === 'string' && QUALITIES.has(ctx.args.quality)
      ? ctx.args.quality as 'low' | 'medium' | 'high'
      : 'medium';

    let image: ImageRequest['image'];
    if (typeof ctx.args.image_path === 'string' && ctx.args.image_path.trim()) {
      const loaded = await loadSourceImage(ctx.workspace, ctx.args.image_path.trim());
      if (typeof loaded === 'string') return { success: false, output: '', error: loaded };
      image = loaded;
    }

    const model = image ? provider.editModel : provider.model;
    const estimate = estimateImageCost(provider, model, quality, env);
    if (deps.costTracker) {
      const check = deps.costTracker.canAfford(estimate);
      if (!check.allowed) {
        return {
          success: false,
          output: '',
          error: `[TOOL_ERROR code=BUDGET_EXCEEDED] Image not generated: ${check.reason}. Tell the user the budget is used up; do not retry.`,
        };
      }
    }

    let result;
    try {
      result = await generateImage(provider, { prompt, image, size, quality }, deps.fetch ?? fetch);
    } catch (error) {
      return { success: false, output: '', error: (error as Error).message };
    }

    // Spend happened as soon as the API answered; record it before anything
    // local (disk, delivery) can fail.
    deps.costTracker?.recordFlatCost({
      model: result.model,
      provider: `image:${result.provider}`,
      sessionId: ctx.sessionId,
      cost: result.costUsd,
    });

    const outputDir = path.join(ctx.workspace, 'output');
    await mkdir(outputDir, { recursive: true });
    const now = deps.now?.() ?? Date.now();
    const fileName = `image-${now}-${slug(prompt)}.${extensionForMime(result.mimeType)}`;
    const filePath = path.join(outputDir, fileName);
    await writeFile(filePath, result.data);

    const caption = typeof ctx.args.caption === 'string' && ctx.args.caption.trim() ? ctx.args.caption.trim() : undefined;
    const wantsDelivery = ctx.args.deliver !== false;
    let delivered = false;
    if (wantsDelivery && deps.deliverFile && ctx.userId) {
      try {
        delivered = await deps.deliverFile(ctx.userId, filePath, caption, ctx);
      } catch {
        delivered = false;
      }
    }

    const relative = path.relative(ctx.workspace, filePath);
    const summary = {
      path: relative,
      provider: result.provider,
      model: result.model,
      bytes: result.data.length,
      cost_usd: Number(result.costUsd.toFixed(4)),
      delivered,
      ...(image ? { edited_from: ctx.args.image_path } : {}),
    };
    const note = delivered
      ? 'The image has already been sent to the user; do not call send_file for it.'
      : wantsDelivery
        ? `Delivery failed; call send_file with file_path "${relative}" to retry.`
        : 'Saved only; call send_file when the user should see it.';
    return { success: true, output: `${JSON.stringify(summary)}\n${note}` };
  };
}
