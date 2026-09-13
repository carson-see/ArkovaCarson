import {
  and, boolType, defineMachine, enumType, eq, lit, not, or, scalarVar, setVar, variable,
} from 'tla-precheck';

const email = variable('email');
const mfa = variable('mfa');
const tokenRole = variable('tokenRole');
const productAccess = variable('productAccess');
const keyProvisionAccess = variable('keyProvisionAccess');

/**
 * UAT-04 human authority flow. Machine API credentials are outside this
 * machine because they never use a Supabase user JWT. The machine models the
 * browser, worker, edge, Data API/RPC, Realtime, and Storage boundary as one
 * productAccess predicate. Adapter-specific tests remain required; this model
 * proves only the authority-state invariants declared below.
 */
export const mandatoryMfaAuthorityMachine = defineMachine({
  version: 2,
  moduleName: 'MandatoryMfaAuthority',
  variables: {
    email: scalarVar(enumType('UNVERIFIED', 'VERIFIED'), lit('UNVERIFIED')),
    mfa: scalarVar(enumType('NONE', 'ENROLLED', 'VERIFIED'), lit('NONE')),
    tokenRole: scalarVar(enumType('EMAIL_PENDING', 'MFA_PENDING', 'AUTHENTICATED'), lit('EMAIL_PENDING')),
    productAccess: scalarVar(boolType(), lit(false)),
    keyProvisionAccess: scalarVar(boolType(), lit(false)),
  },
  actions: {
    confirmEmailNeedsMfa: {
      params: {},
      guard: and(eq(email, lit('UNVERIFIED')), not(eq(mfa, lit('VERIFIED')))),
      updates: [setVar('email', lit('VERIFIED')), setVar('tokenRole', lit('MFA_PENDING'))],
    },
    confirmEmailAfterMfa: {
      params: {},
      guard: and(eq(email, lit('UNVERIFIED')), eq(mfa, lit('VERIFIED'))),
      updates: [setVar('email', lit('VERIFIED')), setVar('tokenRole', lit('AUTHENTICATED'))],
    },
    enrollMfa: {
      params: {},
      guard: eq(mfa, lit('NONE')),
      updates: [setVar('mfa', lit('ENROLLED'))],
    },
    verifyMfaBeforeEmail: {
      params: {},
      guard: and(eq(email, lit('UNVERIFIED')), eq(mfa, lit('ENROLLED'))),
      updates: [setVar('mfa', lit('VERIFIED'))],
    },
    verifyMfaAfterEmail: {
      params: {},
      guard: and(eq(email, lit('VERIFIED')), eq(mfa, lit('ENROLLED'))),
      updates: [setVar('mfa', lit('VERIFIED')), setVar('tokenRole', lit('AUTHENTICATED'))],
    },
    enterProtectedProduct: {
      params: {},
      guard: and(
        eq(email, lit('VERIFIED')),
        eq(mfa, lit('VERIFIED')),
        eq(tokenRole, lit('AUTHENTICATED')),
      ),
      updates: [setVar('productAccess', lit(true)), setVar('keyProvisionAccess', lit(true))],
    },
    beginNewAal1SessionWithoutFactor: {
      params: {},
      guard: and(eq(email, lit('VERIFIED')), eq(mfa, lit('NONE'))),
      updates: [
        setVar('tokenRole', lit('MFA_PENDING')),
        setVar('productAccess', lit(false)),
        setVar('keyProvisionAccess', lit(false)),
      ],
    },
    beginNewAal1SessionWithFactor: {
      params: {},
      guard: and(eq(email, lit('VERIFIED')), eq(mfa, lit('VERIFIED'))),
      updates: [
        setVar('mfa', lit('ENROLLED')),
        setVar('tokenRole', lit('MFA_PENDING')),
        setVar('productAccess', lit(false)),
        setVar('keyProvisionAccess', lit(false)),
      ],
    },
  },
  invariants: {
    productRequiresEmailAndMfa: {
      description: 'No human product surface is reachable before email verification and AAL2',
      formula: or(not(productAccess), and(
        eq(email, lit('VERIFIED')),
        eq(mfa, lit('VERIFIED')),
        eq(tokenRole, lit('AUTHENTICATED')),
      )),
    },
    keyProvisionCannotBypassMfa: {
      description: 'A user JWT cannot provision machine credentials before AAL2',
      formula: or(not(keyProvisionAccess), and(productAccess, eq(mfa, lit('VERIFIED')))),
    },
    emailPendingHasPrecedence: {
      description: 'An unverified mailbox retains the pending role and never receives product authority',
      formula: or(
        eq(email, lit('VERIFIED')),
        and(eq(tokenRole, lit('EMAIL_PENDING')), not(productAccess), not(keyProvisionAccess)),
      ),
    },
  },
  proof: {
    defaultTier: 'pr',
    tiers: {
      pr: {
        domains: {},
        budgets: { maxEstimatedStates: 100_000 },
        checks: { deadlock: false },
        graphEquivalence: true,
      },
    },
  },
});

export default mandatoryMfaAuthorityMachine;
