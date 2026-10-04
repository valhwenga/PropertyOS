-- 0018_credit_note_limit.sql
-- Found by adversarial review, not by a user report.
--
-- `issueCreditNote` checked each credit note against the ORIGINAL document
-- total, but not against what had already been credited. Two notes of R600 each
-- against a R900 charge both passed, crediting R1,200 and leaving the resident
-- in credit on a charge they never overpaid. Two concurrent notes could do the
-- same even with a correct per-note check, because both read a zero
-- already-credited total before either committed.
--
-- The application now locks the original document and checks the cumulative
-- total, which gives a readable error. This trigger is the real guard: it holds
-- even if that code is wrong or bypassed, exactly as the over-allocation
-- trigger does for receipts.

create or replace function app.assert_credit_within_original()
returns trigger
language plpgsql
as $$
declare
  v_original   charge_documents%rowtype;
  v_credited   bigint;
  v_this_note  bigint;
begin
  if new.document_type <> 'credit_note' or new.corrects_document_id is null then
    return new;
  end if;

  -- Lock the original. Concurrent credit notes against one document therefore
  -- serialise, and the second re-reads the true credited total.
  select * into v_original from charge_documents
  where id = new.corrects_document_id for update;

  if not found then
    raise exception 'the document being credited does not exist' using errcode = '23503';
  end if;
  if v_original.organisation_id <> new.organisation_id then
    raise exception 'a credit note cannot cross an organisation boundary' using errcode = '42501';
  end if;
  if v_original.lease_id <> new.lease_id then
    raise exception 'a credit note must be on the same lease as the document it corrects'
      using errcode = '23514';
  end if;
  if v_original.currency_code <> new.currency_code then
    raise exception 'a credit note must be in the same currency as the document it corrects'
      using errcode = '23514';
  end if;

  -- Credit notes carry a negative total, so flip the sign to compare.
  select coalesce(sum(-total_minor), 0) into v_credited
  from charge_documents
  where corrects_document_id = new.corrects_document_id
    and document_type = 'credit_note'
    and status <> 'draft'
    and id <> new.id;

  v_this_note := -new.total_minor;

  if v_credited + v_this_note > v_original.total_minor then
    raise exception
      'crediting % would take the total credited to % against an original of % on document %',
      v_this_note, v_credited + v_this_note, v_original.total_minor, v_original.document_number
      using errcode = '23514',
            hint = 'A document cannot be credited for more than it charged.';
  end if;

  return new;
end;
$$;

create trigger charge_documents_credit_limit
  before insert on charge_documents
  for each row execute function app.assert_credit_within_original();

select app.assert_table_privileges();
