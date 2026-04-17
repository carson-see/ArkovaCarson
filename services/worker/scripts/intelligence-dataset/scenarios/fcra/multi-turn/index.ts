/**
 * Multi-turn FCRA scenario index. 2 seed scenarios per archetype × 10
 * archetypes → ~12 scenarios right now. Lift via NVI-07 distillation
 * (cot-retrofit + Opus teacher) for production volume.
 */

import type { MultiTurnScenario } from '../../../multi-turn';
import { MULTI_TURN_SCENARIOS_1_5 } from './archetypes-1-5';
import { MULTI_TURN_SCENARIOS_6_10 } from './archetypes-6-10';

export const FCRA_MULTI_TURN_SCENARIOS: MultiTurnScenario[] = [
  ...MULTI_TURN_SCENARIOS_1_5,
  ...MULTI_TURN_SCENARIOS_6_10,
];
