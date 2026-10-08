-- 0034_complaints_threshold.sql
-- How many substantiated complaints count as a material breach.
--
-- The first source document fixed this at "more than 3 written complaints from
-- any person residing in the same complex", which is wrong for a freestanding
-- house and wrong for a block of two hundred flats. It is a number per lease,
-- so it lives on the lease.
--
-- Zero is not allowed. A threshold of nought would make every tenancy breachable
-- on the day it starts, and leaving the column null is how a landlord says the
-- clause does not apply to this lease.

alter table lease_agreement_terms
  add column complaints_threshold smallint
    check (complaints_threshold is null or complaints_threshold between 1 and 50);

comment on column lease_agreement_terms.complaints_threshold is
  'The number of substantiated written complaints that counts as a material '
  'breach under clause 9 of the master lease. Null means the clause does not '
  'apply. It does not shorten clause 23: reaching the threshold still needs '
  'written notice and the remedy period before the lease can be cancelled.';
