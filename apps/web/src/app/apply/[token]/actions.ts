'use server';

import { withAnonymous } from '@propertyos/db';
import { parseDayMonthYear, parseMajorToMinor, submitRentalApplication } from '@propertyos/domain';

/**
 * A public submission. There is no session, so this cannot go through
 * `command`, which requires one.
 *
 * It still runs with no actor and no organisation: the token is the only thing
 * that authorises anything, and the database checks it inside
 * app.submit_rental_application. Nothing from this form names an organisation.
 */
export async function submitApplicationAction(_previous: unknown, formData: FormData) {
  const token = String(formData.get('token') ?? '');
  try {
    const incomeText = String(formData.get('monthlyIncome') ?? '').trim();
    const occupantsText = String(formData.get('occupants') ?? '').trim();
    const moveInText = String(formData.get('moveInDate') ?? '').trim();
    const moveInDate = moveInText ? parseDayMonthYear(moveInText) : null;
    if (moveInText && !moveInDate) {
      return { ok: false as const, message: 'Enter the move-in date as dd/mm/yyyy.' };
    }

    const { reference } = await withAnonymous((tx) =>
      submitRentalApplication(tx, token, {
        fullName: String(formData.get('fullName') ?? ''),
        email: String(formData.get('email') ?? ''),
        phone: String(formData.get('phone') ?? ''),
        currentAddress: String(formData.get('currentAddress') ?? ''),
        employment: String(formData.get('employment') ?? ''),
        ...(incomeText ? { monthlyIncomeMinor: parseMajorToMinor(incomeText, 'ZAR') } : {}),
        ...(occupantsText ? { occupants: Number(occupantsText) } : {}),
        ...(moveInDate ? { moveInDate } : {}),
        message: String(formData.get('message') ?? ''),
      }),
    );
    return { ok: true as const, reference };
  } catch (error) {
    // Deliberately plain. The applicant is not told whether the link is dead,
    // revoked or never existed, and nothing about the organisation leaks.
    const message = error instanceof Error ? error.message : 'That could not be submitted.';
    return { ok: false as const, message };
  }
}
