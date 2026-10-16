/**
 * What the sidebar offers each role, resolved by the database.
 *
 * The unit test beside this one checks the filter: given a set of permissions,
 * which sections survive. It cannot check the half that is easy to get wrong —
 * whether the permission a section is keyed on is one the role actually has.
 * A section keyed on a permission nobody holds disappears for everybody, and a
 * section keyed on one everybody holds is no filter at all; both look correct
 * in a unit test and wrong in the product.
 *
 * So this resolves the real `app.has_permission` for the real roles 0008
 * grants, and asserts the menu that comes out.
 *
 * Hiding a section is a courtesy, never a control: the last case here follows
 * a hidden link and expects the server to refuse it anyway.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { listAuditEvents, resolveMenuPermissions } from '@propertyos/domain';
import {
  SECTION_PERMISSIONS, sectionsAwaitingSecondFactor, visibleGroups,
} from '../../apps/web/src/components/operator-sections';
import {
  addMember, as, asSingleFactor, closeOwner, createOrganisation,
  type OrganisationFixture,
} from '../support/factories.js';

/** The sidebar one member would be served, as group and section labels. */
async function sidebar(
  org: OrganisationFixture,
  authUserId: string,
  single = false,
): Promise<{ groups: string[]; sections: string[]; awaiting: number }> {
  const run = single ? asSingleFactor : as;
  const menu = await run(authUserId, (tx) =>
    resolveMenuPermissions(tx, org.organisationId, SECTION_PERMISSIONS));
  const groups = visibleGroups(menu.held);
  return {
    groups: groups.map((g) => g.label),
    sections: groups.flatMap((g) => g.sections.map((s) => s.label)),
    awaiting: sectionsAwaitingSecondFactor(menu.held, menu.withheldForSecondFactor),
  };
}

describe('The sections a member is offered', () => {
  let org: OrganisationFixture;
  let portfolioManager: string;
  let propertyManager: string;
  let preparer: string;
  let approver: string;
  let ownerViewer: string;

  beforeAll(async () => {
    org = await createOrganisation('Sidebar Co');
    portfolioManager = await addMember(org.organisationId, 'Pf Manager', ['portfolio_manager']);
    propertyManager = await addMember(org.organisationId, 'Pr Manager', ['property_manager']);
    preparer = await addMember(org.organisationId, 'Fin Preparer', ['finance_preparer']);
    approver = await addMember(org.organisationId, 'Fin Approver', ['finance_approver']);
    ownerViewer = await addMember(org.organisationId, 'Owner Viewer', ['owner_viewer']);
  });

  afterAll(async () => {
    await closeOwner();
  });

  it('gives an administrator all four areas and every section', async () => {
    const { groups, sections, awaiting } = await sidebar(org, org.adminUserId);
    expect(groups).toEqual(['Portfolio', 'Finance', 'Operations', 'Administration']);
    expect(sections).toContain('Settings');
    expect(sections).toContain('Import');
    expect(sections).toContain('Approvals');
    expect(sections).toContain('Inspections');
    expect(awaiting).toBe(0);
  });

  it('separates the preparer from the approver on the Approvals queue', async () => {
    const prepare = await sidebar(org, preparer);
    const approve = await sidebar(org, approver);

    // Both work in Finance all month.
    expect(prepare.sections).toContain('Reconciliation');
    expect(approve.sections).toContain('Reconciliation');
    // Only one of them is the second pair of eyes. This is §4's separation of
    // duties showing up in the furniture.
    expect(prepare.sections).not.toContain('Approvals');
    expect(approve.sections).toContain('Approvals');
  });

  it('offers a property manager their own work and no finance at all', async () => {
    const { groups, sections } = await sidebar(org, propertyManager);
    expect(groups).toEqual(['Portfolio', 'Operations']);
    expect(sections).toEqual(
      expect.arrayContaining(['Properties', 'Residents', 'Leases', 'Maintenance', 'Inspections']),
    );
    for (const absent of ['Billing', 'Deposits', 'Expenses', 'Reports', 'Settings', 'Import']) {
      expect(sections, `${absent} should not be offered`).not.toContain(absent);
    }
  });

  it('offers a portfolio manager reports but still not the books', async () => {
    const { sections } = await sidebar(org, portfolioManager);
    expect(sections).toContain('Reports');
    expect(sections).toContain('Deposits');
    expect(sections).not.toContain('Billing');
    expect(sections).not.toContain('Reconciliation');
  });

  it('leaves an owner viewer the two things they may read', async () => {
    const { groups, sections } = await sidebar(org, ownerViewer);
    expect(sections.sort()).toEqual(['Properties', 'Reports']);
    expect(groups).toEqual(['Portfolio', 'Finance']);
  });

  it('counts what a single-factor administrator is missing instead of hiding it', async () => {
    const { groups, awaiting } = await sidebar(org, org.adminUserId, true);
    // org_admin requires a second factor, so at one factor the database grants
    // nothing at all and the sidebar collapses to Overview. Leaving it at that
    // is a product that looks broken; the count is what puts the way out on
    // the screen.
    expect(groups).toEqual([]);
    expect(awaiting).toBeGreaterThan(0);
  });

  it('counts nothing for a role that never needed a second factor', async () => {
    const { groups, awaiting } = await sidebar(org, propertyManager, true);
    // property_manager does not require MFA, so one factor costs them nothing
    // and a notice offering them more would be false.
    expect(groups).toEqual(['Portfolio', 'Operations']);
    expect(awaiting).toBe(0);
  });

  it('still refuses the page behind a hidden section', async () => {
    // The whole point: a member who never sees Settings, and types the URL.
    // The audit trail is the clearest case — reading it is its own permission.
    await expect(
      as(propertyManager, (tx) => listAuditEvents(tx, org.organisationId, {})),
    ).rejects.toThrow(/permission/i);
  });
});
