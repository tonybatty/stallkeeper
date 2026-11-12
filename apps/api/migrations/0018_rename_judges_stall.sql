-- Buyers and the owner see the stall name on every item page and the owner heading, and the UI must read as a real
-- product with no demo wording. The row keeps is_demo; only its visible name and location change.
update stalls set name = 'Market stall', location_label = 'Online' where is_demo and name = 'Demo stall';
update items set removed_reason = 'Stall reset' where removed_reason = 'Demo reset' and stall_id in (select id from stalls where is_demo);
