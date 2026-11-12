-- The add and edit forms now have one field, "What buyers should know". Existing text keeps its order: the old condition line, then the old notes.
update items set notes = left(
  case when btrim(notes) = '' then btrim(condition)
       when btrim(condition) ~ '[.!?]$' then btrim(condition) || ' ' || btrim(notes)
       else btrim(condition) || '. ' || btrim(notes) end, 2000);
alter table items drop column condition;
