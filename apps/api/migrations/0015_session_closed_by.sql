-- Who closed a session. A demo reset that closes a session with nothing recorded leaves nothing to report, so the closing page needs to tell it from an owner's Close stall.
-- Sessions closed before this column existed stay null and are judged by their activity alone.
alter table trading_sessions add column closed_by text check (closed_by in ('owner', 'demo_reset'));
