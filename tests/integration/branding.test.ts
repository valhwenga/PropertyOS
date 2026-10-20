/**
 * An organisation's own branding.
 *
 * Three things have to hold, and none of them is about colour. A landlord's
 * logo must not be reachable from another landlord's session. A member who
 * cannot change settings must not be able to change how the product looks to
 * everyone else. And an upload that is not an image must not be stored,
 * whatever it is called — because whatever is stored here is served back to
 * every member of staff and every resident.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withAnonymous } from '@propertyos/db';
import {
  BRAND_ACCENTS, getBranding, getLogo, getSignInBranding, getSignInLogo, removeLogo,
  setBranding, setLogo,
} from '@propertyos/domain';
import {
  addMember, as, closeOwner, createOrganisation, ownerSql, type OrganisationFixture,
} from '../support/factories.js';

/** A structurally real 64×64 PNG: signature, then the IHDR the format requires. */
function png(width = 64, height = 64): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe('Organisation branding', () => {
  let org: OrganisationFixture;
  let other: OrganisationFixture;

  beforeAll(async () => {
    org = await createOrganisation('Branding Rentals');
    other = await createOrganisation('Other Letting');
  });
  afterAll(async () => { await closeOwner(); });

  it('starts as the product’s own palette, with no row at all', async () => {
    const branding = await as(org.adminUserId, (tx) => getBranding(tx, org.organisationId));
    expect(branding).toMatchObject({ accent: 'spike', typeface: 'default', hasLogo: false });
  });

  it('saves an accent and a typeface, and records who changed them', async () => {
    const saved = await as(org.adminUserId, (tx) =>
      setBranding(tx, org.organisationId, org.adminUserId, {
        accent: 'ocean', typeface: 'humanist',
      }));
    expect(saved).toMatchObject({ accent: 'ocean', typeface: 'humanist' });

    const [event] = await ownerSql()<{ action: string; actor_user_id: string }[]>`
      select action, actor_user_id from audit_events
       where organisation_id = ${org.organisationId}
         and action = 'organisation_branding.updated'
       order by occurred_at desc limit 1
    `;
    expect(event?.actor_user_id).toBe(org.adminUserId);
  });

  it('refuses a colour that is not on the list', async () => {
    // The whole reason this is a list: an arbitrary value has never been
    // checked for contrast against anything.
    await expect(as(org.adminUserId, (tx) =>
      setBranding(tx, org.organisationId, org.adminUserId, {
        accent: '#ff00ff', typeface: 'default',
      }))).rejects.toThrow(/accent colours on offer/);

    await expect(as(org.adminUserId, (tx) =>
      setBranding(tx, org.organisationId, org.adminUserId, {
        accent: 'ocean', typeface: 'comic-sans',
      }))).rejects.toThrow(/typefaces on offer/);
  });

  it('offers only accents the stylesheet can paint', async () => {
    // Every key the domain offers must survive the database's own constraint;
    // one that does not would fail at the moment somebody chose it.
    for (const accent of BRAND_ACCENTS) {
      await expect(as(org.adminUserId, (tx) =>
        setBranding(tx, org.organisationId, org.adminUserId, {
          accent: accent.key, typeface: 'default',
        }))).resolves.toMatchObject({ accent: accent.key });
    }
  });

  /* ------------------------------------------------------------- the logo */

  it('stores a logo and reads back what it actually is', async () => {
    const saved = await as(org.adminUserId, (tx) =>
      setLogo(tx, org.organisationId, org.adminUserId, {
        bytes: png(240, 80), filename: 'brand.png',
      }));
    expect(saved).toMatchObject({ hasLogo: true, logoWidth: 240, logoHeight: 80 });

    const logo = await as(org.adminUserId, (tx) => getLogo(tx, org.organisationId));
    expect(logo?.mime).toBe('image/png');
    expect(logo?.bytes.length).toBeGreaterThan(0);
  });

  it('refuses a file that is not an image, whatever it is named', async () => {
    const script = new TextEncoder().encode('<svg onload="fetch(\'/x\')"></svg>');
    await expect(as(org.adminUserId, (tx) =>
      setLogo(tx, org.organisationId, org.adminUserId, {
        bytes: script, filename: 'logo.png',
      }))).rejects.toThrow(/not a PNG or a JPEG/);
  });

  it('refuses one that is too large on disk or on screen', async () => {
    await expect(as(org.adminUserId, (tx) =>
      setLogo(tx, org.organisationId, org.adminUserId, {
        bytes: png(4000, 3000),
      }))).rejects.toThrow(/longest side/);

    const huge = new Uint8Array(600 * 1024);
    huge.set(png(64, 64), 0);
    await expect(as(org.adminUserId, (tx) =>
      setLogo(tx, org.organisationId, org.adminUserId, { bytes: huge }),
    )).rejects.toThrow(/512 KB/);
  });

  it('removes a logo, and says so when there is none', async () => {
    const cleared = await as(org.adminUserId, (tx) =>
      removeLogo(tx, org.organisationId, org.adminUserId));
    expect(cleared.hasLogo).toBe(false);
    expect(await as(org.adminUserId, (tx) => getLogo(tx, org.organisationId))).toBeNull();
    await expect(as(org.adminUserId, (tx) =>
      removeLogo(tx, org.organisationId, org.adminUserId))).rejects.toThrow(/no logo/i);
  });

  /* -------------------------------------------------- who may do any of it */

  it('withholds all of it from a member who cannot manage settings', async () => {
    // A finance preparer can record money; they cannot decide what the product
    // looks like to everybody else.
    const preparer = await addMember(org.organisationId, 'Preparer', ['finance_preparer']);
    await expect(as(preparer, (tx) =>
      setBranding(tx, org.organisationId, preparer, { accent: 'clay', typeface: 'single' }),
    )).rejects.toThrow();
    await expect(as(preparer, (tx) =>
      setLogo(tx, org.organisationId, preparer, { bytes: png() }),
    )).rejects.toThrow();
  });

  it('never shows one landlord’s logo to another', async () => {
    await as(org.adminUserId, (tx) =>
      setLogo(tx, org.organisationId, org.adminUserId, { bytes: png(100, 100) }));

    // The other organisation's admin, asking for this organisation's row by its
    // id. Row level security answers with nothing at all, not with a logo.
    expect(await as(other.adminUserId, (tx) => getLogo(tx, org.organisationId))).toBeNull();
    expect(await as(other.adminUserId, (tx) => getBranding(tx, org.organisationId)))
      .toMatchObject({ hasLogo: false });
    // And their own branding is untouched by ours.
    expect(await as(other.adminUserId, (tx) => getBranding(tx, other.organisationId)))
      .toMatchObject({ accent: 'spike', hasLogo: false });
  });

  it('refuses to write into another organisation’s branding', async () => {
    await expect(as(other.adminUserId, (tx) =>
      setBranding(tx, org.organisationId, other.adminUserId, {
        accent: 'plum', typeface: 'system',
      }))).rejects.toThrow();
  });

  /* ------------------------------------------- the landlord's sign-in page */

  describe('a landlord’s own sign-in page', () => {
    // Nobody is signed in on a sign-in page, so every read here runs with no
    // actor at all: `withAnonymous` is the same transaction shape the page
    // itself uses, and every ordinary RLS policy evaluates to false inside it.

    it('serves the organisation’s colours and mark by slug', async () => {
      await as(org.adminUserId, (tx) =>
        setBranding(tx, org.organisationId, org.adminUserId, {
          accent: 'forest', typeface: 'single',
        }));
      await as(org.adminUserId, (tx) =>
        setLogo(tx, org.organisationId, org.adminUserId, { bytes: png(80, 40) }));

      const branding = await withAnonymous((tx) => getSignInBranding(tx, org.slug));
      expect(branding).toMatchObject({ accent: 'forest', typeface: 'single', hasLogo: true });

      const logo = await withAnonymous((tx) => getSignInLogo(tx, org.slug));
      expect(logo?.mime).toBe('image/png');
    });

    it('tells an unknown slug nothing, by answering exactly as a plain one does', async () => {
      // The whole point: a wrong guess must be indistinguishable from an
      // organisation that simply never chose any branding, so the URL cannot
      // be used to work out who this product's customers are.
      const unknown = await withAnonymous((tx) => getSignInBranding(tx, 'not-a-customer'));
      expect(unknown).toMatchObject({ accent: 'spike', typeface: 'default', hasLogo: false });
      expect(await withAnonymous((tx) => getSignInLogo(tx, 'not-a-customer'))).toBeNull();
    });

    it('stops showing a brand once the organisation is closed', async () => {
      const closing = await createOrganisation('Closing Letting');
      await as(closing.adminUserId, (tx) =>
        setBranding(tx, closing.organisationId, closing.adminUserId, {
          accent: 'plum', typeface: 'default',
        }));
      await as(closing.adminUserId, (tx) =>
        setLogo(tx, closing.organisationId, closing.adminUserId, { bytes: png() }));
      expect(await withAnonymous((tx) => getSignInBranding(tx, closing.slug)))
        .toMatchObject({ accent: 'plum' });

      await ownerSql()`
        update organisations set status = 'closed' where id = ${closing.organisationId}
      `;
      // Their staff can sign in to nothing, so a page wearing their brand
      // would be a promise this product is no longer keeping for them.
      expect(await withAnonymous((tx) => getSignInBranding(tx, closing.slug)))
        .toMatchObject({ accent: 'spike', hasLogo: false });
      expect(await withAnonymous((tx) => getSignInLogo(tx, closing.slug))).toBeNull();
    });

    it('does not expose the branding table itself to an anonymous reader', async () => {
      await expect(withAnonymous((tx) => tx`
        select accent from organisation_branding
         where organisation_id = ${org.organisationId}::uuid
      `)).resolves.toHaveLength(0);
    });
  });
});
