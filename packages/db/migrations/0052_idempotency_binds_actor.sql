-- ---------------------------------------------------------------------------
-- 0052  The key binds the actor, as it always said it did
-- ---------------------------------------------------------------------------
--
-- §20 asks that an idempotency key bind organisation, actor, command and
-- payload. The table's comment in 0006 said exactly that; its unique index did
-- not, covering only (organisation, command, key). The actor was compared
-- afterwards, in application code, against whatever row the index happened to
-- surface.
--
-- That gap is invisible while every key is a fresh UUID and ugly the moment it
-- is not: two people's keys collided on the index, and because one of them
-- could not SEE the other's row under Row Level Security, the conflict
-- surfaced as "that request could not be completed" rather than as two
-- separate requests, which is what they were. A resident in a portal and a
-- clerk in the console are different actors by design, and this is what makes
-- that structural rather than advisory.
--
-- The column becomes NOT NULL in the same breath: a key with no actor cannot
-- bind one, and Postgres treats NULLs as distinct, so a nullable column would
-- quietly re-open the hole it is here to close.

delete from idempotency_keys where actor_user_id is null;
alter table idempotency_keys alter column actor_user_id set not null;

alter table idempotency_keys drop constraint idempotency_keys_organisation_id_command_key_key;
alter table idempotency_keys
  add constraint idempotency_keys_actor_command_key
  unique (organisation_id, actor_user_id, command, key);

select app.assert_table_privileges();
