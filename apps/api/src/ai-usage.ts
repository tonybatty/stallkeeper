import type { Pool, PoolClient } from 'pg';

// Chat, the closing summary, price reviews and the ledger draw on one daily budget, so the price and the table live here.
export async function spentToday(db: Pool | PoolClient, day: string) {
  const { rows } = await db.query<{ cost: string }>('select coalesce((select cost_usd from ai_usage where day=$1),0) as cost', [day]);
  return Number(rows[0]!.cost);
}

export async function ledgerSpentToday(db: Pool | PoolClient, day: string) {
  const { rows } = await db.query<{ cost: string }>('select coalesce((select ledger_cost_usd from ai_usage where day=$1),0) as cost', [day]);
  return Number(rows[0]!.cost);
}

interface Usage {
  inputTokens?: number; outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
}

// US dollars at $2 per million input and $10 per million output. A cache read costs a tenth of input and a cache write
// a quarter more, so billing cached tokens as plain input would overstate a ledger turn by about double.
export function usageCost(usage: Usage) {
  const read = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const write = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const plain = Math.max(0, (usage.inputTokens ?? 0) - read - write);
  return (plain * 2 + read * 0.2 + write * 2.5 + (usage.outputTokens ?? 0) * 10) / 1_000_000;
}

export async function recordUsage(db: Pool, day: string, usage: Usage, source: 'shared' | 'ledger' = 'shared') {
  const cost = usageCost(usage);
  await db.query(`insert into ai_usage (day,input_tokens,output_tokens,cost_usd,ledger_cost_usd) values ($1,$2,$3,$4,$5)
    on conflict (day) do update set input_tokens=ai_usage.input_tokens+excluded.input_tokens,
    output_tokens=ai_usage.output_tokens+excluded.output_tokens, cost_usd=ai_usage.cost_usd+excluded.cost_usd,
    ledger_cost_usd=ai_usage.ledger_cost_usd+excluded.ledger_cost_usd`,
  [day, usage.inputTokens ?? 0, usage.outputTokens ?? 0, cost, source === 'ledger' ? cost : 0]);
}
