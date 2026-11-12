alter table items add column retail_ref jsonb;

create table chat_messages (
  id bigint generated always as identity primary key,
  buyer_session_id uuid not null references buyer_sessions(id),
  item_id uuid not null references items(id),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  answers_id bigint unique references chat_messages(id),
  created_at timestamptz not null default now(),
  check ((role = 'assistant') = (answers_id is not null))
);
create index chat_history on chat_messages(buyer_session_id, item_id, id);

create function keep_chat_history() returns trigger language plpgsql as $$
begin
  raise exception 'Chat history is append-only';
end $$;
create trigger keep_chat_history before update or delete on chat_messages
  for each row execute function keep_chat_history();

create table ai_usage (
  day date primary key,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_usd numeric(14,8) not null default 0
);
