-- ---------------------------------------------------------------------------
-- 0068  An invoice keeps who it was addressed to
-- ---------------------------------------------------------------------------
--
-- A tax invoice carries the recipient's name and address (section 20(4)(c)),
-- and a subscription invoice had neither. Two problems, one of which is not
-- obvious:
--
--   1. The details have to be ON the invoice, not looked up when it is read. A
--      customer who moves office in June must still be able to print the March
--      invoice as it was sent — an address resolved at render time would
--      quietly rewrite history, and a document whose text changes is not a
--      document.
--
--   2. The billing run cannot read them. `organisation_profiles` is customer
--      data and a platform operator holds no membership, so the run that has
--      to print an address cannot see one. The alternative to solving this is
--      an invoice that omits the recipient, which is not a tax invoice.
--
-- `app.platform_customer_billing_identity()` is the narrowest answer: three
-- fields, by organisation, for a platform operator only. A registered name, a
-- registered address and a VAT number are what the customer themselves put on
-- every document they send, and are the minimum for invoicing somebody
-- lawfully. It returns nothing else — no resident, no lease, no balance, no
-- contact for a person — and the function is the only route, so a reviewer can
-- see exactly what Spike may learn about a customer it is billing.

alter table subscription_invoices
  add column recipient_name        text,
  add column recipient_address     text,
  add column recipient_vat_number  text;

comment on column subscription_invoices.recipient_name is
  'Who the invoice was addressed to, as at issue. Null where the customer had '
  'not recorded their particulars; the document then says so rather than '
  'inventing an address.';

create function app.platform_customer_billing_identity(p_org uuid)
returns table (legal_name text, physical_address text, vat_number text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.legal_name, p.physical_address, p.vat_number
    from public.organisation_profiles p
   where p.organisation_id = p_org
     and app.is_platform_operator();
$$;

comment on function app.platform_customer_billing_identity(uuid) is
  'The registered name, address and VAT number of a customer Spike is '
  'invoicing — the minimum for issuing a lawful invoice, and nothing else. '
  'Platform operators only.';

grant execute on function app.platform_customer_billing_identity(uuid)
  to propertyos_app;

select app.assert_table_privileges();
