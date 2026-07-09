/**
 * Connect-issuer dialog — SCRUM-2082 CSI-04D.
 *
 * One dialog that handles both Credly (client_credentials) and
 * Accredible/Udemy (api_key) connection flows. Field set switches on the
 * selected provider. All UI copy lives in `ISSUER_PARTNERSHIP_LABELS`.
 *
 * Defence-in-depth:
 *   - Secret inputs are `type="password"` so browser autofill + screen
 *     capture do not leak them in plain text.
 *   - The form clears the secret fields when the dialog closes regardless
 *     of how it was dismissed.
 */
import { useEffect, useState } from 'react';
import { ISSUER_PARTNERSHIP_LABELS } from '@/lib/copy';

export type ConnectableProvider = 'credly' | 'accredible' | 'udemy';

export interface ConnectIssuerDialogProps {
  open: boolean;
  orgId: string;
  /** Called when the dialog is fully dismissed (close button, ESC, cancel). */
  onClose: () => void;
  /**
   * Called with the body the worker endpoint expects. Caller is responsible
   * for the network call so this component stays decoupled from
   * fetch / TanStack Query and so unit tests can run without a server.
   */
  onSubmit: (body: ConnectIssuerSubmitBody) => Promise<void>;
  /** Surface a submission error inline; cleared when fields change. */
  submitError?: string | null;
}

export type ConnectIssuerSubmitBody =
  | {
      provider: 'credly';
      org_id: string;
      account_id: string;
      account_label?: string;
      credentials: { client_id: string; client_secret: string };
    }
  | {
      provider: 'accredible' | 'udemy';
      org_id: string;
      account_id: string;
      account_label?: string;
      credentials: { api_key: string; key_label?: string };
    };

export function ConnectIssuerDialog({
  open,
  orgId,
  onClose,
  onSubmit,
  submitError,
}: ConnectIssuerDialogProps) {
  const [provider, setProvider] = useState<ConnectableProvider>('credly');
  const [accountId, setAccountId] = useState('');
  const [accountLabel, setAccountLabel] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [keyLabel, setKeyLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Always clear secrets on close — never leave them in component state.
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear secret fields when dialog closes (defence-in-depth)
      setClientSecret('');
      setApiKey('');
    }
  }, [open]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const body: ConnectIssuerSubmitBody =
        provider === 'credly'
          ? {
              provider: 'credly',
              org_id: orgId,
              account_id: accountId,
              account_label: accountLabel || undefined,
              credentials: { client_id: clientId, client_secret: clientSecret },
            }
          : {
              provider,
              org_id: orgId,
              account_id: accountId,
              account_label: accountLabel || undefined,
              credentials: {
                api_key: apiKey,
                key_label: keyLabel || undefined,
              },
            };
      await onSubmit(body);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="connect-issuer-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
        <h2 id="connect-issuer-title" className="text-lg font-semibold">
          {ISSUER_PARTNERSHIP_LABELS.CONNECT_DIALOG_TITLE}
        </h2>
        <p className="mt-2 text-sm text-gray-600">
          {ISSUER_PARTNERSHIP_LABELS.CONNECT_DIALOG_BODY}
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label htmlFor="provider" className="block text-sm font-medium">
              {ISSUER_PARTNERSHIP_LABELS.CONNECT_FIELD_PROVIDER}
            </label>
            <select
              id="provider"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
              value={provider}
              onChange={(e) => setProvider(e.target.value as ConnectableProvider)}
            >
              <option value="credly">
                {ISSUER_PARTNERSHIP_LABELS.PROVIDER_NAMES.credly}
              </option>
              <option value="accredible">
                {ISSUER_PARTNERSHIP_LABELS.PROVIDER_NAMES.accredible}
              </option>
              <option value="udemy">
                {ISSUER_PARTNERSHIP_LABELS.PROVIDER_NAMES.udemy}
              </option>
            </select>
            <p className="mt-1 text-xs text-gray-500">
              {ISSUER_PARTNERSHIP_LABELS.CONNECT_FIELD_PROVIDER_HELP}
            </p>
          </div>

          <div>
            <label htmlFor="account_id" className="block text-sm font-medium">
              {ISSUER_PARTNERSHIP_LABELS.CONNECT_FIELD_ACCOUNT_ID}
            </label>
            <input
              id="account_id"
              type="text"
              required
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            />
          </div>

          <div>
            <label htmlFor="account_label" className="block text-sm font-medium">
              {ISSUER_PARTNERSHIP_LABELS.CONNECT_FIELD_ACCOUNT_LABEL}
            </label>
            <input
              id="account_label"
              type="text"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
              value={accountLabel}
              onChange={(e) => setAccountLabel(e.target.value)}
            />
          </div>

          {provider === 'credly' ? (
            <>
              <div>
                <label htmlFor="client_id" className="block text-sm font-medium">
                  {ISSUER_PARTNERSHIP_LABELS.CONNECT_FIELD_CLIENT_ID}
                </label>
                <input
                  id="client_id"
                  type="text"
                  required
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="client_secret" className="block text-sm font-medium">
                  {ISSUER_PARTNERSHIP_LABELS.CONNECT_FIELD_CLIENT_SECRET}
                </label>
                <input
                  id="client_secret"
                  type="password"
                  required
                  autoComplete="new-password"
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <label htmlFor="api_key" className="block text-sm font-medium">
                  {ISSUER_PARTNERSHIP_LABELS.CONNECT_FIELD_API_KEY}
                </label>
                <input
                  id="api_key"
                  type="password"
                  required
                  autoComplete="new-password"
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="key_label" className="block text-sm font-medium">
                  {ISSUER_PARTNERSHIP_LABELS.CONNECT_FIELD_KEY_LABEL}
                </label>
                <input
                  id="key_label"
                  type="text"
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1"
                  value={keyLabel}
                  onChange={(e) => setKeyLabel(e.target.value)}
                />
              </div>
            </>
          )}

          {submitError ? (
            <p role="alert" className="text-sm text-red-600">
              {submitError}
            </p>
          ) : null}

          <div className="flex items-center justify-end space-x-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded border border-gray-300 px-3 py-1 text-sm"
            >
              {ISSUER_PARTNERSHIP_LABELS.CONNECT_CANCEL}
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              {ISSUER_PARTNERSHIP_LABELS.CONNECT_SUBMIT}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
