/**
 * Narrow re-export of the privileged connection for the PRE-SESSION
 * authentication path only.
 *
 * Authentication necessarily runs before any session exists, so there is no RLS
 * context to run under. The tables it touches (auth.users, auth_mfa_factors,
 * auth_attempts) are explicitly revoked from the application roles, so this is
 * the only route to them — and keeping it in a separate module means any other
 * use shows up clearly in review.
 *
 * Nothing in this module may be used to read or write customer data.
 */
export { privilegedSql } from './client';
