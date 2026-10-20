-- ---------------------------------------------------------------------------
-- 0059  A landlord's own sign-in page
-- ---------------------------------------------------------------------------
--
-- Staff at a letting agency sign in several times a week, and the page they
-- sign in on is this product's, not theirs. `/sign-in/<slug>` makes it theirs:
-- their accent, their typeface, their logo.
--
-- Nobody is signed in when that page renders, so this cannot go through the
-- branding table's own policy — there is no auth.uid() to be a member with. It
-- goes through a security-definer function instead, and what that function
-- returns is the narrowest thing that will do the job.
--
-- What it deliberately does NOT return: the organisation's name, its trading
-- name, its status, how many people are in it, when anything changed. A page
-- rendered from this shows a mark and a colour and the words "Sign in"; it
-- cannot be read as a directory of who this product's customers are, and it
-- never tells the caller whether a slug that produced nothing was wrong or
-- merely unbranded.
--
-- What it does concede: somebody who GUESSES an organisation's slug correctly
-- sees that organisation's logo, which is a mark they could also have found on
-- the landlord's own website. That is the same exposure every vanity sign-in
-- URL carries, and it is the point of having one. A slug that is wrong, or an
-- organisation that is suspended or closed, is indistinguishable from one that
-- does not exist.

create or replace function app.sign_in_branding(p_slug text)
returns table (
  accent text,
  typeface text,
  has_logo boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.accent, b.typeface, b.logo_bytes is not null
  from public.organisations o
  join public.organisation_branding b on b.organisation_id = o.id
  where o.slug = p_slug
    -- A closed or suspended customer's brand is not shown. Their staff cannot
    -- sign in to anything anyway, and a mark on a working-looking page is a
    -- promise this product is not keeping for them.
    and o.status in ('trial', 'active')
  limit 1;
$$;

comment on function app.sign_in_branding(text) is
  'Accent, typeface and whether a logo exists, by organisation slug, for the '
  'unauthenticated sign-in page. Returns no name and nothing identifying.';

grant execute on function app.sign_in_branding(text) to propertyos_app;

-- The bytes, for the route that serves them. Separate from the settings above
-- so rendering a page never carries half a megabyte it will not use.
create or replace function app.sign_in_logo(p_slug text)
returns table (
  logo_bytes bytea,
  logo_mime text,
  logo_updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select b.logo_bytes, b.logo_mime, b.logo_updated_at
  from public.organisations o
  join public.organisation_branding b on b.organisation_id = o.id
  where o.slug = p_slug
    and o.status in ('trial', 'active')
    and b.logo_bytes is not null
  limit 1;
$$;

comment on function app.sign_in_logo(text) is
  'The logo bytes for an organisation''s own sign-in page, by slug.';

grant execute on function app.sign_in_logo(text) to propertyos_app;

select app.assert_table_privileges();
