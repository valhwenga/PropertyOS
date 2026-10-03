-- 0008_views_reference.sql
-- Derived views and reference data.
--
-- Every view is created with security_invoker = true so that Row Level Security
-- on the underlying tables applies to the *querying* user. Without this a view
-- would run with the owner's privileges and silently become an isolation hole.

-- ---------------------------------------------------------------------------
-- Balance views
-- ---------------------------------------------------------------------------

-- Outstanding amount per charge line, after allocations and linked credit notes.
create view charge_line_balances with (security_invoker = true) as
select
  cl.id                       as charge_line_id,
  cl.organisation_id,
  cl.document_id,
  cl.lease_id,
  cl.category,
  cl.description,
  cl.due_date,
  cl.currency_code,
  cl.amount_minor,
  coalesce(alloc.allocated_minor, 0)                       as allocated_minor,
  cl.amount_minor - coalesce(alloc.allocated_minor, 0)     as outstanding_minor
from charge_lines cl
join charge_documents cd on cd.id = cl.document_id
left join lateral (
  select sum(pa.amount_minor) as allocated_minor
  from payment_allocations pa
  where pa.charge_line_id = cl.id and pa.reversed_at is null
) alloc on true
where cd.status = 'posted';

-- Unapplied (credit) balance per receipt. An overpayment stays here as traceable
-- credit rather than being forced onto a charge.
create view receipt_balances with (security_invoker = true) as
select
  r.id            as receipt_id,
  r.organisation_id,
  r.book_id,
  r.lease_id,
  r.receipt_number,
  r.received_on,
  r.currency_code,
  r.amount_minor,
  coalesce(a.allocated_minor, 0)                      as allocated_minor,
  r.amount_minor - coalesce(a.allocated_minor, 0)     as unapplied_minor,
  r.in_suspense
from receipts r
left join lateral (
  select sum(pa.amount_minor) as allocated_minor
  from payment_allocations pa
  where pa.receipt_id = r.id and pa.reversed_at is null
) a on true
where r.status = 'confirmed';

-- The resident statement, as an ordered event stream. The running balance is
-- derived from these dated rows, never from a manually maintained counter.
--
-- Deliberately excluded: payment evidence (unverified), and deposit movements
-- (a separate liability that does not reduce the rent receivable).
create view lease_ledger_entries with (security_invoker = true) as
  select
    cl.organisation_id,
    cl.lease_id,
    cd.issue_date                       as entry_date,
    cl.due_date,
    'charge'::text                      as entry_kind,
    cd.document_type::text              as entry_type,
    cd.document_number                  as reference,
    cl.description,
    cl.currency_code,
    -- A positive charge is a debit to the resident; a credit note is negative
    -- and lands on the credit side.
    greatest(cl.amount_minor, 0)        as debit_minor,
    greatest(-cl.amount_minor, 0)       as credit_minor,
    cl.id                               as source_id,
    cd.posted_at                        as posted_at
  from charge_lines cl
  join charge_documents cd on cd.id = cl.document_id
  where cd.status = 'posted'
union all
  select
    pa.organisation_id,
    cl.lease_id,
    r.received_on                       as entry_date,
    r.received_on                       as due_date,
    'allocation'::text                  as entry_kind,
    'receipt_allocation'::text          as entry_type,
    r.receipt_number                    as reference,
    'Receipt allocated to ' || cl.description as description,
    pa.currency_code,
    0::bigint                           as debit_minor,
    pa.amount_minor                     as credit_minor,
    pa.id                               as source_id,
    pa.allocated_at                     as posted_at
  from payment_allocations pa
  join receipts r on r.id = pa.receipt_id
  join charge_lines cl on cl.id = pa.charge_line_id
  where pa.reversed_at is null;

-- Net receivable per lease. Unapplied credit is reported separately so a tenant
-- in credit is never confused with a tenant with no arrears.
create view lease_balances with (security_invoker = true) as
select
  l.id                as lease_id,
  l.organisation_id,
  l.property_id,
  l.unit_id,
  l.currency_code,
  coalesce(c.charged_minor, 0)        as charged_minor,
  coalesce(c.allocated_minor, 0)      as allocated_minor,
  coalesce(c.charged_minor, 0) - coalesce(c.allocated_minor, 0) as receivable_minor,
  coalesce(u.unapplied_minor, 0)      as unapplied_credit_minor,
  coalesce(d.deposit_held_minor, 0)   as deposit_held_minor
from leases l
left join lateral (
  select
    sum(cl.amount_minor) as charged_minor,
    sum(coalesce((select sum(pa.amount_minor) from payment_allocations pa
                  where pa.charge_line_id = cl.id and pa.reversed_at is null), 0)) as allocated_minor
  from charge_lines cl
  join charge_documents cd on cd.id = cl.document_id
  where cl.lease_id = l.id and cd.status = 'posted'
) c on true
left join lateral (
  select sum(rb.unapplied_minor) as unapplied_minor
  from receipt_balances rb where rb.lease_id = l.id
) u on true
left join lateral (
  select sum(de.amount_minor) as deposit_held_minor
  from deposit_accounts da
  join deposit_events de on de.deposit_account_id = da.id
  where da.lease_id = l.id
) d on true;

-- Arrears ageing. Buckets are driven by due date, not invoice creation date, and
-- a partial payment leaves the remainder in its original bucket.
create view arrears_ageing with (security_invoker = true) as
select
  b.organisation_id,
  b.lease_id,
  b.currency_code,
  sum(b.outstanding_minor) filter (where b.due_date > current_date) as not_yet_due_minor,
  sum(b.outstanding_minor) filter (where b.due_date <= current_date and current_date - b.due_date <= 30) as days_1_30_minor,
  sum(b.outstanding_minor) filter (where current_date - b.due_date between 31 and 60) as days_31_60_minor,
  sum(b.outstanding_minor) filter (where current_date - b.due_date between 61 and 90) as days_61_90_minor,
  sum(b.outstanding_minor) filter (where current_date - b.due_date > 90) as days_over_90_minor,
  sum(b.outstanding_minor) as total_outstanding_minor
from charge_line_balances b
where b.outstanding_minor > 0
group by b.organisation_id, b.lease_id, b.currency_code;

-- Trial balance: proves every book balances from the journals alone.
create view trial_balance with (security_invoker = true) as
select
  j.organisation_id,
  j.book_id,
  j.currency_code,
  a.code       as account_code,
  a.name       as account_name,
  a.account_type,
  a.system_role,
  sum(jl.debit_minor)  as debit_minor,
  sum(jl.credit_minor) as credit_minor,
  sum(jl.signed_minor) as net_minor
from journal_lines jl
join journals j on j.id = jl.journal_id
join accounts a on a.id = jl.account_id
group by j.organisation_id, j.book_id, j.currency_code,
         a.code, a.name, a.account_type, a.system_role;

grant select on charge_line_balances, receipt_balances, lease_ledger_entries,
  lease_balances, arrears_ageing, trial_balance
  to propertyos_app, propertyos_worker;

-- ---------------------------------------------------------------------------
-- Reference data: permissions
-- ---------------------------------------------------------------------------
insert into permissions (key, description) values
  ('organisation.settings.manage',  'Change organisation configuration'),
  ('membership.manage',             'Invite, assign roles to and suspend members'),
  ('support.access.manage',         'Authorise and revoke Spike support sessions'),
  ('portfolio.read',                'View portfolios and properties in scope'),
  ('property.create',               'Create properties and units'),
  ('property.update',               'Edit properties, buildings and units'),
  ('resident.read',                 'View resident profiles in scope'),
  ('resident.manage',               'Create and edit resident profiles'),
  ('resident.identity.read',        'View resident identity document details'),
  ('lease.read',                    'View leases in scope'),
  ('lease.create',                  'Draft leases'),
  ('lease.activate',                'Activate and renew leases'),
  ('lease.close',                   'Close or cancel leases'),
  ('billing.preview',               'Preview and validate billing runs'),
  ('billing.post',                  'Post approved billing runs and charges'),
  ('charge.adjust',                 'Issue credit notes and adjustments'),
  ('payment.record',                'Record and confirm receipts'),
  ('payment.allocate',              'Allocate receipts to charges'),
  ('payment.reverse',               'Reverse allocations and receipts'),
  ('bank.import',                   'Import and reconcile bank statements'),
  ('deposit.read',                  'View deposit accounts'),
  ('deposit.record',                'Record deposit receipts and deductions'),
  ('deposit.refund.approve',        'Approve deposit refunds and deductions'),
  ('expense.record',                'Record property expenses'),
  ('expense.approve',               'Approve property expenses'),
  ('maintenance.read',              'View maintenance tickets'),
  ('maintenance.manage',            'Triage, assign and resolve tickets'),
  ('maintenance.quote.approve',     'Approve maintenance quotations'),
  ('inspection.manage',             'Create and finalise inspections'),
  ('document.read',                 'Download private documents in scope'),
  ('document.manage',               'Upload and share documents'),
  ('document.identity.read',        'Download identity documents'),
  ('report.read',                   'View reports and exports'),
  ('period.lock',                   'Lock and reopen accounting periods'),
  ('platform.admin',                'Spike platform administration')
on conflict (key) do nothing;

insert into roles (key, name, description, requires_mfa) values
  ('spike_operator',     'Spike operator',            'Platform administration; customer content only via an authorised support session', true),
  ('org_admin',          'Organisation administrator','Full control of one customer organisation', true),
  ('portfolio_manager',  'Portfolio manager',         'Operations across assigned portfolios', false),
  ('property_manager',   'Property manager',          'Operations on assigned properties', false),
  ('finance_preparer',   'Finance preparer',          'Prepares billing, receipts and expenses; cannot approve refunds', false),
  ('finance_approver',   'Finance approver',          'Posts approved batches, refunds and reversals', true),
  ('owner_viewer',       'Owner viewer',              'Read-only performance view of owned properties', false),
  ('resident',           'Resident',                  'Self-service access to own lease', false),
  ('contractor',         'Contractor',                'Assigned maintenance jobs only (Phase 2 portal)', false)
on conflict (key) do nothing;

insert into role_permissions (role_key, permission_key)
select 'org_admin', key from permissions where key <> 'platform.admin'
on conflict do nothing;

insert into role_permissions (role_key, permission_key) values
  ('portfolio_manager', 'portfolio.read'),
  ('portfolio_manager', 'property.create'),
  ('portfolio_manager', 'property.update'),
  ('portfolio_manager', 'resident.read'),
  ('portfolio_manager', 'resident.manage'),
  ('portfolio_manager', 'lease.read'),
  ('portfolio_manager', 'lease.create'),
  ('portfolio_manager', 'lease.activate'),
  ('portfolio_manager', 'lease.close'),
  ('portfolio_manager', 'maintenance.read'),
  ('portfolio_manager', 'maintenance.manage'),
  ('portfolio_manager', 'maintenance.quote.approve'),
  ('portfolio_manager', 'inspection.manage'),
  ('portfolio_manager', 'document.read'),
  ('portfolio_manager', 'document.manage'),
  ('portfolio_manager', 'report.read'),
  ('portfolio_manager', 'deposit.read'),

  ('property_manager', 'portfolio.read'),
  ('property_manager', 'property.update'),
  ('property_manager', 'resident.read'),
  ('property_manager', 'resident.manage'),
  ('property_manager', 'lease.read'),
  ('property_manager', 'lease.create'),
  ('property_manager', 'maintenance.read'),
  ('property_manager', 'maintenance.manage'),
  ('property_manager', 'inspection.manage'),
  ('property_manager', 'document.read'),
  ('property_manager', 'document.manage'),

  ('finance_preparer', 'portfolio.read'),
  ('finance_preparer', 'resident.read'),
  ('finance_preparer', 'lease.read'),
  ('finance_preparer', 'billing.preview'),
  ('finance_preparer', 'payment.record'),
  ('finance_preparer', 'payment.allocate'),
  ('finance_preparer', 'bank.import'),
  ('finance_preparer', 'deposit.read'),
  ('finance_preparer', 'deposit.record'),
  ('finance_preparer', 'expense.record'),
  ('finance_preparer', 'report.read'),
  ('finance_preparer', 'document.read'),

  ('finance_approver', 'portfolio.read'),
  ('finance_approver', 'resident.read'),
  ('finance_approver', 'lease.read'),
  ('finance_approver', 'billing.preview'),
  ('finance_approver', 'billing.post'),
  ('finance_approver', 'charge.adjust'),
  ('finance_approver', 'payment.record'),
  ('finance_approver', 'payment.allocate'),
  ('finance_approver', 'payment.reverse'),
  ('finance_approver', 'bank.import'),
  ('finance_approver', 'deposit.read'),
  ('finance_approver', 'deposit.record'),
  ('finance_approver', 'deposit.refund.approve'),
  ('finance_approver', 'expense.record'),
  ('finance_approver', 'expense.approve'),
  ('finance_approver', 'period.lock'),
  ('finance_approver', 'report.read'),
  ('finance_approver', 'document.read'),

  ('owner_viewer', 'portfolio.read'),
  ('owner_viewer', 'report.read'),

  ('spike_operator', 'platform.admin')
on conflict do nothing;

insert into plans (key, name, included_units, monthly_price_minor, currency_code, additional_unit_price_minor) values
  ('starter',      'Starter',      10,   29900, 'ZAR', 1200),
  ('portfolio',    'Portfolio',    50,   89900, 'ZAR', 1200),
  ('professional', 'Professional', 150, 199900, 'ZAR', 1200),
  ('enterprise',   'Enterprise',  1000,      0, 'ZAR', 0)
on conflict (key) do nothing;

insert into plan_entitlements (plan_key, feature, limit_value) values
  ('starter', 'staff_accounts', 3),
  ('starter', 'documents_gb', 5),
  ('portfolio', 'staff_accounts', 10),
  ('portfolio', 'documents_gb', 25),
  ('professional', 'staff_accounts', 25),
  ('professional', 'documents_gb', 100),
  ('enterprise', 'staff_accounts', null),
  ('enterprise', 'documents_gb', null)
on conflict do nothing;

insert into notification_templates (key, channel, subject, body) values
  ('resident.invitation', 'email', 'Your resident portal access',
   'Hello {{resident_name}},\n\nYour landlord has given you access to the {{organisation_name}} resident portal for {{property_name}}.\n\nAccept your invitation: {{invite_url}}\n\nThis link expires on {{expires_at}}.'),
  ('statement.issued', 'email', 'Your statement for {{period}}',
   'Hello {{resident_name}},\n\nYour statement for {{period}} is available in the portal. Amount due: {{amount_due}} by {{due_date}}.\n\nSign in: {{portal_url}}'),
  ('payment.evidence.received', 'in_app', 'Proof of payment received',
   'We received your proof of payment of {{amount}}. It is awaiting verification against our bank records and has not yet been applied to your balance.'),
  ('maintenance.ticket.created', 'in_app', 'Maintenance request {{reference}}',
   'Your maintenance request {{reference}} has been logged. A portal ticket is not a guarantee of emergency response; for an emergency use the contact details on your lease.')
on conflict (key) do nothing;
