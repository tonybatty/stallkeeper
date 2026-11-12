-- The stall ledger's assistant has its own share of the daily budget, so owner questions cannot use up buyer chat.
-- cost_usd stays the total for the day, and this column is the part of it the ledger spent.
alter table ai_usage add column ledger_cost_usd numeric(14,8) not null default 0;
