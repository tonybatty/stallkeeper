-- The AI summary and the PayPal cross-check run when the owner asks, so each result is kept with the closing.
-- summary_key identifies the report content the summary was written from, so it is never shown against different numbers.
alter table closings
  add column summary text,
  add column summary_key text,
  add column paypal_check jsonb;
