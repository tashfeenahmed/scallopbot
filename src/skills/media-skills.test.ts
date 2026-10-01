import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SkillLoader } from './loader.js';
import { SkillRegistry } from './registry.js';
import { registerMediaSkills } from './media-skills.js';
import type { MessageDeliveryHandler } from '../triggers/types.js';

const BUNDLED = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bundled');

async function loadBundled(names: string[]) {
  const loader = new SkillLoader({});
  const skills = [];
  for (const name of names) {
    const skill = await loader.loadSkillFile(path.join(BUNDLED, name, 'SKILL.md'), 'bundled');
    if (skill) skills.push(skill);
  }
  return skills;
}

describe('registerMediaSkills', () => {
  it('loads the bundled SKILL.md files and attaches in-process handlers', async () => {
    const skills = await loadBundled(['image_gen', 'phone_call', 'sms']);
    expect(skills.map(s => s.name)).toEqual(['image_gen', 'phone_call', 'sms']);
    const registry = new SkillRegistry({ loadAll: async () => skills } as unknown as SkillLoader);
    await registry.initialize();

    registerMediaSkills({ registry, env: { FAL_KEY: 'k' } });

    const image = registry.getSkill('image_gen')!;
    expect(image.handler).toBeTypeOf('function');
    expect(image.source).toBe('sdk');
    expect(image.frontmatter.inputSchema?.required).toEqual(['prompt']);
    expect(registry.getToolDefinitions().map(t => t.name)).toContain('image_gen');
    expect(registry.getSkill('phone_call')!.handler).toBeTypeOf('function');
    expect(registry.getSkill('phone_call')!.frontmatter.metadata?.openclaw?.safety?.externalWrite).toBe(true);
  });

  it('hides image_gen when no image provider key is configured', async () => {
    const skills = await loadBundled(['image_gen']);
    const registry = new SkillRegistry({ loadAll: async () => skills } as unknown as SkillLoader);
    await registry.initialize();

    registerMediaSkills({ registry, env: {} });

    expect(registry.getSkill('image_gen')!.available).toBe(false);
    expect(registry.getToolDefinitions().map(t => t.name)).not.toContain('image_gen');
  });

  describe('reminder call escalation', () => {
    const env = {
      TWILIO_ACCOUNT_SID: 'AC1',
      TWILIO_AUTH_TOKEN: 't',
      TWILIO_FROM_NUMBER: '+15005550006',
      PHONE_OWNER_NUMBER: '+447700900999',
    };
    const reminderMeta = (text: string) => ({
      scheduledItemId: 'r1',
      ownerUserId: 'telegram:1',
      outcome: { source: 'scheduler' as const, activeRequest: text, explicitUserText: true },
    });

    function setup(mode: string) {
      const registry = new SkillRegistry({ loadAll: async () => [] } as unknown as SkillLoader);
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ sid: 'CA1', status: 'queued' }), { status: 201 }),
      );
      const media = registerMediaSkills({ registry, env: { ...env, PHONE_REMINDER_CALLS: mode } });
      const inner = vi.fn().mockResolvedValue(true) as unknown as MessageDeliveryHandler;
      inner.supportsDeliveryMetadata = true;
      return { wrapped: media.withReminderCalls(inner), fetchMock };
    }

    it('calls the owner for a tagged reminder when opted in', async () => {
      const { wrapped, fetchMock } = setup('tagged');
      expect(wrapped.supportsDeliveryMetadata).toBe(true);
      await wrapped('telegram:1', '**Take your meds**', reminderMeta('Take your meds - call me'));
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const form = new URLSearchParams(fetchMock.mock.calls[0][1]!.body as string);
      expect(form.get('To')).toBe('+447700900999');
      expect(form.get('Twiml')).toContain('reminder. Take your meds');
      fetchMock.mockRestore();
    });

    it('does nothing when off, untagged, or not a user reminder', async () => {
      const off = setup('off');
      await off.wrapped('telegram:1', 'x', reminderMeta('call me'));
      off.fetchMock.mockRestore();

      const tagged = setup('tagged');
      await tagged.wrapped('telegram:1', 'x', reminderMeta('stretch'));
      await tagged.wrapped('telegram:1', 'x', { ...reminderMeta('call me'), outcome: { source: 'proactive' as const, activeRequest: 'call me' } });
      await new Promise(r => setTimeout(r, 10));
      expect(off.fetchMock).not.toHaveBeenCalled();
      expect(tagged.fetchMock).not.toHaveBeenCalled();
      tagged.fetchMock.mockRestore();
    });
  });
});
