/**
 * Moonshot spend guard for eval runs.
 *
 * Every runner checks the account balance before starting another unit of
 * work (a task, a conversation) and stops scheduling new work once the
 * balance is at or below the floor. Work already in flight finishes, so set
 * the floor with a margin of a few runs above the real limit.
 */

const BALANCE_URL = 'https://api.moonshot.ai/v1/users/me/balance';

export interface MoonshotBalance {
  available: number;
  cash: number;
  voucher: number;
}

export async function moonshotBalance(apiKey = process.env.MOONSHOT_API_KEY): Promise<MoonshotBalance> {
  if (!apiKey) throw new Error('MOONSHOT_API_KEY is not set');
  const response = await fetch(BALANCE_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json() as {
    status?: boolean;
    data?: { available_balance?: number; cash_balance?: number; voucher_balance?: number };
  };
  if (!response.ok || !body.status || !body.data) {
    throw new Error(`Moonshot balance check failed: HTTP ${response.status}`);
  }
  return {
    available: Number(body.data.available_balance ?? 0),
    cash: Number(body.data.cash_balance ?? 0),
    voucher: Number(body.data.voucher_balance ?? 0),
  };
}

/**
 * Returns a checker that is true while spending may continue. Balance
 * lookups are cached for `cacheMs` so concurrent workers don't hammer the
 * endpoint; a failed lookup stops spending (fail closed).
 */
export function createBudgetGuard(floor: number, options: { cacheMs?: number; log?: (line: string) => void } = {}) {
  const cacheMs = options.cacheMs ?? 15_000;
  let checkedAt = 0;
  let last: number | null = null;
  let stopped = false;
  return async function canSpend(): Promise<boolean> {
    if (stopped) return false;
    if (Date.now() - checkedAt > cacheMs || last === null) {
      try {
        last = (await moonshotBalance()).available;
      } catch (error) {
        options.log?.(`[budget] balance check failed (${(error as Error).message}); stopping new work`);
        stopped = true;
        return false;
      }
      checkedAt = Date.now();
    }
    if (last <= floor) {
      options.log?.(`[budget] balance $${last.toFixed(2)} is at or below the floor $${floor.toFixed(2)}; stopping new work`);
      stopped = true;
      return false;
    }
    return true;
  };
}
