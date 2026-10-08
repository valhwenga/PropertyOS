-- 0039_agreement_completeness.sql
-- Which of an agreement's gaps actually matter.
--
-- `missing_fields` has been recorded since 0020, and every gap counted the
-- same: a missing VAT number sat beside a missing tenant name. The catalogue
-- has carried an `essential` flag since then too — the fields without which the
-- document is not a usable lease — and nothing has ever read it.
--
-- So an agreement with no tenant identity number, no commencement date and no
-- rent could be generated and shared with the resident, showing "[money.rent]"
-- where the rent belongs. §7 is explicit that activation requires "an attached
-- executed contract or documented exception", and a document with blanks in its
-- operative terms is neither.
--
-- This records the essential subset separately so sharing can refuse on it
-- while a draft generation stays possible. Being able to generate an incomplete
-- draft is the point: it is how an operator SEES what is still missing.

alter table lease_agreement_generations
  add column essential_missing text[] not null default '{}';

comment on column lease_agreement_generations.essential_missing is
  'The subset of missing_fields the catalogue marks essential. Non-empty means '
  'this agreement may be generated as a draft but not shared with the resident.';

-- Backfill is deliberately NOT attempted. The essential set is a property of
-- the catalogue at generation time, and guessing it retrospectively would put
-- a value in this column that no generation actually produced. Existing rows
-- therefore read as '{}' — not "complete", but "this was generated before the
-- check existed", which is what the interface says about them.
