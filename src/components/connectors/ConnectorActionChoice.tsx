/**
 * Connectors page — action choice radio group (SPEC-CONNECTORS §1.4, D1).
 *
 * Two options only — "Hold for my review" (`QUEUE_FOR_REVIEW`) is
 * deliberately NOT a third option here; §9 defers it. Stacked radios always
 * (never side-by-side), per §5 mobile guidance — a two-column layout on a
 * 375px viewport is exactly the kind of thing that reads fine on desktop and
 * clips on a phone, so there is no responsive variant to get wrong.
 */
import { CONNECTORS_LABELS } from '@/lib/copy';
import type { ConnectorActionType } from './useConnectorRule';

interface ConnectorActionChoiceProps {
  value: ConnectorActionType;
  onChange: (value: ConnectorActionType) => void;
  disabled?: boolean;
  name: string;
}

const OPTIONS: Array<{ value: ConnectorActionType; label: string; help: string }> = [
  {
    value: 'INSTANT_SECURE',
    label: CONNECTORS_LABELS.CONNECTOR_ACTION_INSTANT,
    help: CONNECTORS_LABELS.CONNECTOR_ACTION_INSTANT_HELP,
  },
  {
    value: 'AUTO_ANCHOR',
    label: CONNECTORS_LABELS.CONNECTOR_ACTION_QUEUE,
    help: CONNECTORS_LABELS.CONNECTOR_ACTION_QUEUE_HELP,
  },
];

export function ConnectorActionChoice({ value, onChange, disabled, name }: ConnectorActionChoiceProps) {
  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-sm font-medium">{CONNECTORS_LABELS.CONNECTOR_ACTION_HEADING}</legend>
      <div className="flex flex-col gap-3">
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              disabled={disabled}
              className="mt-1 h-4 w-4 shrink-0"
              aria-describedby={`${name}-${option.value}-help`}
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{option.label}</span>
              <span id={`${name}-${option.value}-help`} className="text-xs text-muted-foreground">
                {option.help}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
