/**
 * Document-grounded FCRA scenario index.
 *
 * 9 seed scenarios across 8 synthetic/anonymized documents. Lift via
 * NVI-07 distillation + privacy-reviewed production samples toward the
 * 150+ target.
 */

import type { DocumentGroundedScenario } from '../../../document-grounded';
import { FCRA_DOC_GROUNDED_SEED } from './seed-scenarios';

export const FCRA_DOC_GROUNDED_SCENARIOS: DocumentGroundedScenario[] = [...FCRA_DOC_GROUNDED_SEED];
