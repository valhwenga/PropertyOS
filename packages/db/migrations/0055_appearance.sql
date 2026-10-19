-- ---------------------------------------------------------------------------
-- 0055  Appearance: a remembered theme, and a landlord's own branding
-- ---------------------------------------------------------------------------
--
-- Two different things, deliberately stored in two different places.
--
--  * The light/dark choice belongs to a PERSON. It followed the browser until
--    now, so signing in on a second machine started over and a shared device
--    showed one colleague the other's choice. It goes on `user_profiles`,
--    which already has a self-select and a self-update policy keyed on
--    auth.uid(), so no new policy is needed to keep it private.
--
--  * The accent colour, the typeface and the logo belong to an ORGANISATION.
--    A letting agency's residents should see the agency's brand, not Spike's.
--    Branding is read by every member of the organisation and by the residents
--    of its leases; it is written only with organisation.settings.manage.
--
-- The logo's bytes live in this table rather than in `documents`. A document
-- is quarantined until a scanner clears it, and quarantined bytes must never
-- be served — which is correct for a resident's uploaded bank statement and
-- useless for a logo that has to appear on every page. So a logo takes a
-- separate, much narrower path: PNG or JPEG only, validated by magic bytes and
-- by its own header, capped at 512 KB and 1024 px, and served from this
-- application's own origin with a content type this database recorded rather
-- than one the uploader claimed.

/* ------------------------------------------------------ the person's theme */

alter table user_profiles
  add column if not exists theme_choice text not null default 'system'
    check (theme_choice in ('light', 'dark', 'system'));

comment on column user_profiles.theme_choice is
  'Light, dark, or follow the device. Per person, not per browser; a device '
  'can still override it for one session without changing this.';

/* --------------------------------------------------- the organisation brand */

create table organisation_branding (
  organisation_id uuid primary key references organisations (id) on delete cascade,
  -- A key from the vetted palette, never a free-form hex. Every preset is
  -- checked for contrast against white and against the ink ramp; a colour
  -- picker would let an administrator make their own product unreadable, and
  -- the first person to suffer is a resident with low vision.
  accent          text not null default 'spike',
  -- Likewise a key, not a font file. Serving an uploaded binary font is a
  -- larger attack surface than a brand is worth, and a font with different
  -- metrics reflows every table and every generated PDF.
  typeface        text not null default 'default',
  logo_bytes      bytea,
  logo_mime       text,
  logo_width      integer,
  logo_height     integer,
  logo_filename   text,
  logo_updated_at timestamptz,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users (id),

  constraint organisation_branding_accent
    check (accent in ('spike', 'ink', 'ocean', 'forest', 'clay', 'plum', 'slate')),
  constraint organisation_branding_typeface
    check (typeface in ('default', 'single', 'humanist', 'system')),
  constraint organisation_branding_logo_mime
    check (logo_mime is null or logo_mime in ('image/png', 'image/jpeg')),
  -- A half-stored logo would render as a broken image on every page, so the
  -- parts of one are present together or not at all.
  constraint organisation_branding_logo_whole
    check (
      (logo_bytes is null and logo_mime is null
        and logo_width is null and logo_height is null)
      or (logo_bytes is not null and logo_mime is not null
        and logo_width is not null and logo_height is not null)
    ),
  constraint organisation_branding_logo_size
    check (logo_bytes is null or octet_length(logo_bytes) <= 524288),
  constraint organisation_branding_logo_pixels
    check (
      logo_width is null
      or (logo_width between 16 and 1024 and logo_height between 16 and 1024)
    )
);

comment on table organisation_branding is
  'One row per organisation: accent key, typeface key and an optional logo. '
  'The logo bytes are here rather than in documents because a document is '
  'quarantined until scanned and a quarantined file must never be served.';

alter table organisation_branding enable row level security;

-- Read by everyone who works in the organisation. The resident path does not
-- go through this policy; it goes through the security-definer function below,
-- because a resident has no membership.
create policy organisation_branding_select on organisation_branding
  for select using (
    app.is_org_member(organisation_id) or app.has_support_access(organisation_id)
  );
create policy organisation_branding_write on organisation_branding
  for all
  using (app.has_permission(organisation_id, 'organisation.settings.manage'))
  with check (app.has_permission(organisation_id, 'organisation.settings.manage'));

grant select, insert, update, delete on organisation_branding
  to propertyos_app, propertyos_worker;

/* ------------------------------------------------- what a resident may read */

-- A resident sees their landlord's brand, and nothing else about the
-- organisation. Note what this does NOT return: no updated_by, no timestamps,
-- nothing that would tell a tenant who in the agency changed what.
create or replace function app.resident_branding(p_lease uuid)
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
  from public.leases l
  join public.organisation_branding b on b.organisation_id = l.organisation_id
  where l.id = p_lease
    and app.can_access_lease_as_resident(p_lease)
  limit 1;
$$;

comment on function app.resident_branding(uuid) is
  'The accent, typeface and whether a logo exists, for a resident of this lease.';

grant execute on function app.resident_branding(uuid) to propertyos_app, propertyos_worker;

-- The bytes themselves, for the route that serves the logo to a resident. Kept
-- separate from the settings above so an ordinary page render never carries
-- half a megabyte it is not going to use.
create or replace function app.resident_logo(p_lease uuid)
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
  from public.leases l
  join public.organisation_branding b on b.organisation_id = l.organisation_id
  where l.id = p_lease
    and app.can_access_lease_as_resident(p_lease)
    and b.logo_bytes is not null
  limit 1;
$$;

grant execute on function app.resident_logo(uuid) to propertyos_app, propertyos_worker;

select app.assert_table_privileges();
