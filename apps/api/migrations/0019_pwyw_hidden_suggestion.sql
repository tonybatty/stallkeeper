-- A pay-what-you-want item can keep its suggested amount from buyers, so they name a price with no anchor. The suggestion
-- stays in asking_pence for the owner, the ledger and the minimum's upper bound; only buyer responses leave it out.
alter table items add column suggestion_hidden boolean not null default false;
alter table items add constraint items_suggestion_hidden_pwyw check (not suggestion_hidden or mode = 'pwyw');
