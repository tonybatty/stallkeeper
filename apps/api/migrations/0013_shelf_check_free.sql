alter table shelf_checks add column free boolean not null default false;
update shelf_checks sc set free=true from items i where i.id=sc.item_id and i.mode='free';
