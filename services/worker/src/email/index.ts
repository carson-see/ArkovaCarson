/**
 * Email Module (BETA-03)
 *
 * Barrel export for email infrastructure.
 */

export { sendEmail, _resetClient } from './sender.js';
export type { SendResult, SendEmailOptions } from './sender.js';
export {
  buildActivationEmail,
  buildAnchorSecuredEmail,
  buildRevocationEmail,
} from './templates.js';
export type {
  ActivationEmailData,
  AnchorSecuredEmailData,
  RevocationEmailData,
} from './templates.js';
