-- A third pricing mode. The suggested amount lives in asking_pence. The optional minimum is shown to buyers, so it sits on the item and never in the private item_floors.
alter table items drop constraint items_mode_check;
alter table items add constraint items_mode_check check (mode in ('fixed', 'haggle', 'pwyw'));
alter table items add column minimum_pence integer check (minimum_pence is null or (mode = 'pwyw' and minimum_pence between 1 and asking_pence));
