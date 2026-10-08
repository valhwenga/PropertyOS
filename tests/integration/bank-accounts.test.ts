/**
 * Banking details: fresh authentication, honest verification, real history.
 *
 * A diverted account number is the most profitable attack on a letting
 * business — change four digits and every resident pays a stranger, in good
 * faith, with a valid reference. These tests are written against that, not
 * against the happy path.
 *
 * Note what `as` does NOT supply: an authentication instant. An ordinary test
 * session is therefore STALE, and anything gated on freshness has to opt in
 * through `asFreshlyAuthenticated`. A command that forgets its gate fails here
 * rather than passing because every session happened to look fresh.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  addBankAccount, bankAccountHistory, changeBankAccountNumber, listBankAccounts,
  setBankAccountActive, updateBankAccountDetails, verifyBankAccount,
} from '@propertyos/domain';
import {
  addMember, as, asFreshlyAuthenticated, asSingleFactor, asStaleAuthentication,
  closeOwner, createOrganisation, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

describe('Banking details', () => {
  let org: OrganisationFixture;
  let other: OrganisationFixture;
  let accountId: string;
  let preparerUserId: string;

  beforeAll(async () => {
    org = await createOrganisation('Banking Co');
    other = await createOrganisation('Other Banking Co');

    // addMember creates the user and returns its id; it takes a name, not an id.
    preparerUserId = await addMember(org.organisationId, 'Prep Arer', ['finance_preparer']);

    const created = await as(org.adminUserId, (tx) =>
      addBankAccount(tx, org.organisationId, org.adminUserId, {
        label: 'Rent account', bankName: 'Standard Bank', accountHolder: 'Banking Co (Pty) Ltd',
        accountNumber: '40 488 8321', branchCode: '009953', accountRole: 'operating',
        reason: 'Opening banking details during onboarding.',
      }),
    );
    accountId = created.bankAccountId;
  });

  afterAll(async () => { await closeOwner(); });

  /* --------------------------------------------------------------- exposure */

  it('never returns the full account number', async () => {
    const [account] = await as(org.adminUserId, (tx) => listBankAccounts(tx, org.organisationId));
    expect(account!.accountNumberLast4).toBe('8321');
    expect(JSON.stringify(account)).not.toContain('404888321');
    expect(JSON.stringify(account)).not.toContain('40 488 8321');
    // And nothing resembling the sealed bytes either.
    expect(Object.keys(account!)).not.toContain('accountNumberCipher');
  });

  it('seals the stored number rather than keeping it readable', async () => {
    const [row] = await ownerSql()<{ cipher: Buffer; last4: string }[]>`
      select account_number_cipher as cipher, account_number_last4 as last4
        from bank_accounts where id = ${accountId}
    `;
    expect(row!.last4).toBe('8321');
    // Sealed, not merely encoded: the digits must not appear in the bytes.
    expect(row!.cipher.toString('utf8')).not.toContain('404888321');
    expect(row!.cipher.length).toBeGreaterThan(29); // version + iv + tag + body
  });

  /* ----------------------------------------------------- fresh authentication */

  it('refuses to change the number on a session that has not re-authenticated', async () => {
    // The session is aal2 and holds the permission. It is simply not recent.
    await expect(
      asStaleAuthentication(org.adminUserId, (tx) =>
        changeBankAccountNumber(tx, org.organisationId, org.adminUserId, {
          bankAccountId: accountId, accountNumber: '9999999999',
          reason: 'Attacker with a borrowed open session.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'reauthentication_required' });
  });

  it('treats a session with no authentication instant at all as stale', async () => {
    // Absent evidence is not evidence. This is the case a fail-open bug would
    // let through, so it is asserted separately from the expired case.
    await expect(
      as(org.adminUserId, (tx) =>
        changeBankAccountNumber(tx, org.organisationId, org.adminUserId, {
          bankAccountId: accountId, accountNumber: '9999999999',
          reason: 'Session that never proved a second factor instant.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'reauthentication_required' });
  });

  it('refuses a single-factor session before freshness is even considered', async () => {
    await expect(
      asSingleFactor(org.adminUserId, (tx) =>
        changeBankAccountNumber(tx, org.organisationId, org.adminUserId, {
          bankAccountId: accountId, accountNumber: '9999999999',
          reason: 'Password-only session.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('allows the change once identity has just been proved', async () => {
    await asFreshlyAuthenticated(org.adminUserId, (tx) =>
      changeBankAccountNumber(tx, org.organisationId, org.adminUserId, {
        bankAccountId: accountId, accountNumber: '62 115 4477',
        reason: 'Moved banking to a new account after the branch closed.',
      }),
    );
    const [account] = await as(org.adminUserId, (tx) => listBankAccounts(tx, org.organisationId));
    expect(account!.accountNumberLast4).toBe('4477');
  });

  /* ------------------------------------------------------------ verification */

  it('withdraws verification when the number changes', async () => {
    // The previous number may have been confirmed by the bank. This one has
    // not been confirmed by anyone, and must not inherit that assurance.
    const [account] = await as(org.adminUserId, (tx) => listBankAccounts(tx, org.organisationId));
    expect(account!.verifiedAt).toBeNull();
    expect(account!.verificationMethod).toBe('none');
    expect(account!.verificationLabel).toBe('Not verified — nobody has checked these details');
  });

  it('records HOW the details were verified, not merely that they were', async () => {
    await asFreshlyAuthenticated(org.adminUserId, (tx) =>
      verifyBankAccount(tx, org.organisationId, org.adminUserId, {
        bankAccountId: accountId, method: 'bank_document',
        note: 'Stamped bank letter dated 2 October, filed under the lease.',
        reason: 'Verified against the bank letter supplied by the landlord.',
      }),
    );
    const [account] = await as(org.adminUserId, (tx) => listBankAccounts(tx, org.organisationId));
    expect(account!.verificationMethod).toBe('bank_document');
    expect(account!.verificationLabel).toBe('A bank letter or stamped statement was sighted');
    expect(account!.verifiedAt).not.toBeNull();
  });

  it('refuses "verified" with no method behind it', async () => {
    await expect(
      asFreshlyAuthenticated(org.adminUserId, (tx) =>
        verifyBankAccount(tx, org.organisationId, org.adminUserId, {
          bankAccountId: accountId, method: 'none',
          reason: 'Trying to mark it verified without saying how.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('cannot be left verified with no method, even from the database side', async () => {
    // The application rule above has a constraint underneath it, so a direct
    // write cannot produce a row that claims verification it cannot explain.
    await expect(ownerSql()`
      update bank_accounts set verified_at = now(), verification_method = 'none'
       where id = ${accountId}
    `).rejects.toThrow(/bank_accounts_verification_is_explained/);
  });

  /* ---------------------------------------------------------------- history */

  it('keeps a history naming who changed what, and whether they re-authenticated', async () => {
    const history = await as(org.adminUserId, (tx) =>
      bankAccountHistory(tx, org.organisationId, accountId),
    );
    const types = history.map((h) => h.changeType);
    expect(types).toContain('created');
    expect(types).toContain('account_number_changed');
    expect(types).toContain('verified');

    const change = history.find((h) => h.changeType === 'account_number_changed')!;
    expect(change.previousLast4).toBe('8321');
    expect(change.newLast4).toBe('4477');
    expect(change.reason).toContain('branch closed');
    expect(change.freshAuthentication).toBe(true);
    expect(change.changedByName).toBeTruthy();
  });

  it('keeps only the last four digits in the history, never the number', async () => {
    const [row] = await ownerSql()<Record<string, unknown>[]>`
      select * from bank_account_changes
       where bank_account_id = ${accountId} and change_type = 'account_number_changed'
    `;
    expect(JSON.stringify(row)).not.toContain('621154477');
  });

  it('cannot be rewritten or deleted', async () => {
    // An audit trail that can be edited is not evidence of anything. Asserted
    // against the APPLICATION role, which is what a request actually runs as.
    const [change] = await as(org.adminUserId, (tx) =>
      bankAccountHistory(tx, org.organisationId, accountId),
    );
    await expect(
      as(org.adminUserId, (tx) => tx`
        update bank_account_changes set reason = 'rewritten' where id = ${change!.id}
      `),
    ).rejects.toThrow();
    await expect(
      as(org.adminUserId, (tx) => tx`
        delete from bank_account_changes where id = ${change!.id}
      `),
    ).rejects.toThrow();
  });

  it('demands a reason for every change', async () => {
    await expect(
      asFreshlyAuthenticated(org.adminUserId, (tx) =>
        changeBankAccountNumber(tx, org.organisationId, org.adminUserId, {
          bankAccountId: accountId, accountNumber: '1234567890', reason: 'x',
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  /* ------------------------------------------------------------ permissions */

  it('lets a finance preparer read the masked details but not change them', async () => {
    // §4: the person who prepares is not the person who approves. Reading the
    // account to reconcile a statement is ordinary work; redirecting the rent
    // is not.
    const accounts = await as(preparerUserId, (tx) => listBankAccounts(tx, org.organisationId));
    expect(accounts).toHaveLength(1);

    await expect(
      asFreshlyAuthenticated(preparerUserId, (tx) =>
        changeBankAccountNumber(tx, org.organisationId, preparerUserId, {
          bankAccountId: accountId, accountNumber: '5555555555',
          reason: 'A preparer should not be able to do this.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('does not show one organisation another organisation\'s banking', async () => {
    const accounts = await as(other.adminUserId, (tx) =>
      listBankAccounts(tx, other.organisationId),
    );
    expect(accounts).toEqual([]);

    // And naming the other organisation's id explicitly changes nothing: the
    // permission is resolved against membership, not against the argument.
    await expect(
      as(other.adminUserId, (tx) => listBankAccounts(tx, org.organisationId)),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('cannot be reached by id from another organisation', async () => {
    await expect(
      asFreshlyAuthenticated(other.adminUserId, (tx) =>
        changeBankAccountNumber(tx, other.organisationId, other.adminUserId, {
          bankAccountId: accountId, accountNumber: '7777777777',
          reason: 'Knowing a valid id must not be enough.',
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  /* ------------------------------------------------------------- lifecycle */

  it('deactivates rather than deletes, so history keeps resolving', async () => {
    await asFreshlyAuthenticated(org.adminUserId, (tx) =>
      setBankAccountActive(tx, org.organisationId, org.adminUserId, {
        bankAccountId: accountId, active: false,
        reason: 'Account closed by the bank; superseded by the new one.',
      }),
    );
    const [account] = await as(org.adminUserId, (tx) => listBankAccounts(tx, org.organisationId));
    expect(account!.isActive).toBe(false);
    // Still there, still readable, still pointed at by anything that referenced it.
    expect(account!.accountNumberLast4).toBe('4477');
  });

  it('records a details change without touching the number', async () => {
    await asFreshlyAuthenticated(org.adminUserId, (tx) =>
      updateBankAccountDetails(tx, org.organisationId, org.adminUserId, {
        bankAccountId: accountId, label: 'Rent account (closed)',
        bankName: 'Standard Bank', accountHolder: 'Banking Co (Pty) Ltd',
        reason: 'Renamed to make the closure obvious in lists.',
      }),
    );
    const [account] = await as(org.adminUserId, (tx) => listBankAccounts(tx, org.organisationId));
    expect(account!.label).toBe('Rent account (closed)');
    expect(account!.accountNumberLast4).toBe('4477');
    // Changing the label does not un-verify the account; changing the NUMBER does.
    expect(account!.verificationMethod).toBe('bank_document');
  });
});
