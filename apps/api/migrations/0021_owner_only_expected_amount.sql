-- Buyers no longer see a suggested amount or tip, so for pay what you want and free items asking_pence is the owner's own
-- expected figure: optional, and never sent to a buyer. This build no longer writes suggestion_hidden, so a mode change would leave it
-- set on an item that is not pay what you want: its check goes. The column stays, because the build before this one still reads and writes it.
-- A checkout line copies the item's figure, so it is optional there too. Fixed and haggle items still need an asking price.
alter table items drop constraint items_suggestion_hidden_pwyw;
alter table items alter column asking_pence drop not null;
alter table items add constraint items_asking_pence_required check (asking_pence is not null or mode in ('pwyw', 'free'));
alter table checkout_lines alter column asking_pence drop not null;
