-- 0040_expense_accounting.sql
-- What an expense does to the books, and the one invoice rule.
--
-- Two gaps, both of which would misstate something.
--
-- ACCOUNTS PAYABLE. `expenses` has carried `approved` and `paid` as separate
-- states since 0006, with no account to hold the difference. Posting an
-- approved-but-unpaid expense straight against the bank would say money had
-- left the account when it had not; waiting until payment would leave an
-- approved liability invisible. §14 asks for net operating income AND cash
-- surplus as distinct measures, which is only possible when the two states post
-- to different places.
--
--   on approval: debit Property operating expense, credit Accounts payable
--   on payment:  debit Accounts payable,           credit Landlord bank control
--
-- §10 is explicit that this is a proposed operational model and an accountant
-- must confirm the chart of accounts before it is relied on commercially. This
-- migration adds the account; it does not claim the model has been reviewed.
--
-- ONE INVOICE, ONE EXPENSE. §11: "A receipt must not be counted twice because
-- it is attached to both a maintenance ticket and an expense." An invoice
-- attached to a work order and then expensed again is the ordinary way that
-- happens, and nothing prevented it.

alter table accounts
  drop constraint if exists accounts_system_role_check;

alter table accounts
  add constraint accounts_system_role_check check (system_role in (
    'resident_receivable', 'unapplied_receipts', 'rental_income',
    'utility_recovery_income', 'other_income', 'bank_control',
    'deposit_bank_control', 'deposit_liability', 'deposit_interest_expense',
    'suspense', 'property_expense', 'write_off_expense', 'opening_equity',
    'accounts_payable'));

-- Every existing book gets the account, so an organisation created before this
-- migration can record an expense without a separate setup step.
insert into accounts (organisation_id, book_id, code, name, account_type, system_role)
select b.organisation_id, b.id, 'AP_TRADE', 'Accounts payable', 'liability', 'accounts_payable'
  from financial_books b
 where not exists (
   select 1 from accounts a where a.book_id = b.id and a.system_role = 'accounts_payable'
 );

comment on column accounts.system_role is
  'The accounts the domain resolves by role rather than by code. Adding one here '
  'means adding it to DEFAULT_ACCOUNTS in organisations.ts and backfilling every '
  'existing book, as this migration does.';

-- ---------------------------------------------------------------------------
-- One invoice, one expense
-- ---------------------------------------------------------------------------
--
-- Voided expenses are excluded: an invoice expensed in error, voided, and
-- recorded again correctly is a legitimate sequence. What is refused is the
-- same invoice counting twice at the same time.

create unique index expenses_one_per_invoice_document
  on expenses (organisation_id, invoice_document_id)
  where invoice_document_id is not null and status <> 'void';

comment on index expenses_one_per_invoice_document is
  'An invoice document may back at most one live expense. Attaching the same '
  'receipt to a maintenance ticket and then expensing it again is how a cost '
  'gets counted twice, and §11 says it must not.';
