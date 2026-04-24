/**
 * API Sandbox — Interactive API Testing Playground
 *
 * Allows developers to test Arkova Verification API endpoints directly
 * in the browser. Supports API Key and x402 payment authentication.
 * Synthetic Sentinel design system.
 */

import { useState, useMemo, useCallback } from 'react';
import {
  Play,
  Copy,
  Check,
  ChevronDown,
  Key,
  CreditCard,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { PUBLIC_API_URL } from '@/lib/workerClient';
import { DEVELOPER_PAGE_LABELS as L } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

// ── Endpoint definitions ────────────────────────────────────────────────────

interface EndpointParam {
  name: string;
  label: string;
  type: 'text' | 'select';
  placeholder?: string;
  required?: boolean;
  options?: { label: string; value: string }[];
}

interface EndpointDef {
  id: string;
  method: 'GET' | 'POST';
  path: string;
  label: string;
  price: string;
  description: string;
  params: EndpointParam[];
}

const ENDPOINTS: EndpointDef[] = [
  {
    id: 'verify',
    method: 'GET',
    path: '/api/v1/verify/:publicId',
    label: 'Verify Credential',
    price: '$0.002',
    description: 'Verify a credential by its public ID and receive full cryptographic proof.',
    params: [
      { name: 'publicId', label: 'Public ID', type: 'text', placeholder: 'abc123-def456', required: true },
    ],
  },
  {
    id: 'verify-batch',
    method: 'POST',
    path: '/api/v1/verify/batch',
    label: 'Batch Verification',
    price: '$0.002/item',
    description: 'Verify multiple credentials in a single request. Up to 100 items per batch.',
    params: [
      { name: 'public_ids', label: 'Public IDs (comma-separated)', type: 'text', placeholder: 'abc123,def456,ghi789', required: true },
    ],
  },
  {
    id: 'v2-search',
    method: 'GET',
    path: '/api/v2/search',
    label: 'Search Everything',
    price: 'API key',
    description: 'Search organizations, records, fingerprints, and documents with one API-key endpoint.',
    params: [
      { name: 'q', label: 'Search Query', type: 'text', placeholder: 'Acme, contract.pdf, or a SHA-256 fingerprint', required: true },
      {
        name: 'type',
        label: 'Type',
        type: 'select',
        options: [
          { label: 'All', value: 'all' },
          { label: 'Organizations', value: 'org' },
          { label: 'Records', value: 'record' },
          { label: 'Fingerprints', value: 'fingerprint' },
          { label: 'Documents', value: 'document' },
        ],
      },
    ],
  },
  {
    id: 'v2-organizations',
    method: 'GET',
    path: '/api/v2/organizations',
    label: 'Search Organizations',
    price: 'API key',
    description: 'Find organization profiles by name, domain, or description.',
    params: [
      { name: 'q', label: 'Organization Query', type: 'text', placeholder: 'Acme University', required: true },
    ],
  },
  {
    id: 'v2-records',
    method: 'GET',
    path: '/api/v2/records',
    label: 'Search Records',
    price: 'API key',
    description: 'Find anchored records by filename, description, or fingerprint.',
    params: [
      { name: 'q', label: 'Record Query', type: 'text', placeholder: 'employment contract', required: true },
    ],
  },
  {
    id: 'v2-fingerprints',
    method: 'GET',
    path: '/api/v2/fingerprints',
    label: 'Search Fingerprints',
    price: 'API key',
    description: 'Look up exact SHA-256 fingerprints and get matching public record IDs.',
    params: [
      { name: 'q', label: 'Fingerprint', type: 'text', placeholder: '64-character SHA-256 hex', required: true },
    ],
  },
  {
    id: 'v2-documents',
    method: 'GET',
    path: '/api/v2/documents',
    label: 'Search Documents',
    price: 'API key',
    description: 'Find document-like records by filename or description.',
    params: [
      { name: 'q', label: 'Document Query', type: 'text', placeholder: 'msa.pdf', required: true },
    ],
  },
  {
    id: 'entity',
    method: 'GET',
    path: '/api/v1/verify/entity',
    label: 'Entity Lookup',
    price: '$0.005',
    description: 'Look up an entity by name, domain, or identifier across the credential registry.',
    params: [
      { name: 'name', label: 'Entity Name', type: 'text', placeholder: 'Acme University' },
      { name: 'domain', label: 'Domain', type: 'text', placeholder: 'acme.edu' },
      { name: 'identifier', label: 'Identifier', type: 'text', placeholder: 'OPEID:00123400' },
    ],
  },
  {
    id: 'compliance',
    method: 'GET',
    path: '/api/v1/compliance/check',
    label: 'Compliance Check',
    price: '$0.010',
    description: 'Run a compliance check against an entity within a specific jurisdiction.',
    params: [
      { name: 'entity', label: 'Entity Name', type: 'text', placeholder: 'Acme Corp', required: true },
      { name: 'jurisdiction', label: 'Jurisdiction', type: 'text', placeholder: 'US-CA' },
    ],
  },
  {
    id: 'regulatory',
    method: 'GET',
    path: '/api/v1/regulatory/lookup',
    label: 'Regulatory Lookup',
    price: '$0.002',
    description: 'Query regulatory records by keyword and optionally filter by source.',
    params: [
      { name: 'query', label: 'Query', type: 'text', placeholder: 'higher education accreditation', required: true },
      { name: 'source', label: 'Source Filter', type: 'text', placeholder: 'DAPIP' },
    ],
  },
  {
    id: 'cle',
    method: 'GET',
    path: '/api/v1/cle/verify',
    label: 'CLE Verification',
    price: '$0.005',
    description: 'Verify CLE compliance for an attorney by bar number and jurisdiction.',
    params: [
      { name: 'barNumber', label: 'Bar Number', type: 'text', placeholder: '12345', required: true },
      { name: 'jurisdiction', label: 'Jurisdiction', type: 'text', placeholder: 'CA' },
    ],
  },
  {
    id: 'ai-search',
    method: 'POST',
    path: '/api/v1/ai/search',
    label: 'AI Semantic Search',
    price: '$0.010',
    description: 'Semantic search across the credential registry using natural language queries.',
    params: [
      { name: 'query', label: 'Search Query', type: 'text', placeholder: 'accredited nursing programs in California', required: true },
    ],
  },
  {
    id: 'nessie',
    method: 'GET',
    path: '/api/v1/nessie/query',
    label: 'Nessie AI Query',
    price: '$0.010',
    description: 'Query the Nessie AI assistant for credential intelligence and regulatory insights.',
    params: [
      { name: 'query', label: 'Query', type: 'text', placeholder: 'What are the accreditation requirements for nursing schools?', required: true },
      { name: 'mode', label: 'Mode', type: 'select', options: [{ label: 'Retrieval', value: 'retrieval' }, { label: 'Context', value: 'context' }] },
    ],
  },
];

type AuthMode = 'apikey' | 'x402';

export function ApiSandbox() {
  const [selectedEndpoint, setSelectedEndpoint] = useState<string>(ENDPOINTS[0].id);
  const [authMode, setAuthMode] = useState<AuthMode>('apikey');
  const [apiKey, setApiKey] = useState('');
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [response, setResponse] = useState<string | null>(null);
  const [responseStatus, setResponseStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [copiedFetch, setCopiedFetch] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const endpoint = useMemo(
    () => ENDPOINTS.find((e) => e.id === selectedEndpoint) ?? ENDPOINTS[0],
    [selectedEndpoint],
  );

  const handleSelectEndpoint = useCallback((id: string) => {
    setSelectedEndpoint(id);
    setParamValues({});
    setResponse(null);
    setResponseStatus(null);
    setError(null);
    setDropdownOpen(false);
  }, []);

  const setParam = useCallback((name: string, value: string) => {
    setParamValues((prev) => ({ ...prev, [name]: value }));
  }, []);

  // Build the actual URL for the request
  const requestUrl = useMemo(() => {
    let path = endpoint.path;
    // Replace path params
    if (endpoint.id === 'verify' && paramValues.publicId) {
      path = path.replace(':publicId', encodeURIComponent(paramValues.publicId));
    }
    // Build query string for GET requests
    if (endpoint.method === 'GET') {
      const queryParams = endpoint.params
        .filter((p) => p.name !== 'publicId' && paramValues[p.name])
        .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(paramValues[p.name] || '')}`)
        .join('&');
      if (queryParams) path += `?${queryParams}`;
    }
    return `${PUBLIC_API_URL}${path}`;
  }, [endpoint, paramValues]);

  // Build request body for POST endpoints
  const requestBody = useMemo(() => {
    if (endpoint.method !== 'POST') return null;
    const body: Record<string, unknown> = {};
    for (const p of endpoint.params) {
      if (paramValues[p.name]) {
        if (p.name === 'public_ids') {
          body[p.name] = paramValues[p.name].split(',').map((s) => s.trim());
        } else {
          body[p.name] = paramValues[p.name];
        }
      }
    }
    return body;
  }, [endpoint, paramValues]);

  // Generate curl command
  const curlCommand = useMemo(() => {
    const lines = [`curl -X ${endpoint.method} \\`];
    lines.push(`  "${requestUrl}" \\`);
    if (authMode === 'apikey') {
      lines.push(`  -H "Authorization: Bearer ${apiKey || 'YOUR_API_KEY'}" \\`);
    }
    if (endpoint.method === 'POST') {
      lines.push('  -H "Content-Type: application/json" \\');
      lines.push(`  -d '${JSON.stringify(requestBody ?? {}, null, 2)}'`);
    } else {
      // Remove trailing backslash from last line
      lines[lines.length - 1] = lines[lines.length - 1].replace(/ \\$/, '');
    }
    return lines.join('\n');
  }, [endpoint, requestUrl, authMode, apiKey, requestBody]);

  // Generate fetch code
  const fetchCode = useMemo(() => {
    const headers: Record<string, string> = {};
    if (authMode === 'apikey') {
      headers['Authorization'] = `Bearer ${apiKey || 'YOUR_API_KEY'}`;
    }
    if (endpoint.method === 'POST') {
      headers['Content-Type'] = 'application/json';
    }

    const opts: string[] = [`  method: '${endpoint.method}'`];
    if (Object.keys(headers).length > 0) {
      opts.push(`  headers: ${JSON.stringify(headers, null, 4).replace(/\n/g, '\n  ')}`);
    }
    if (endpoint.method === 'POST' && requestBody) {
      opts.push(`  body: JSON.stringify(${JSON.stringify(requestBody, null, 4).replace(/\n/g, '\n  ')})`);
    }

    return `const response = await fetch('${requestUrl}', {\n${opts.join(',\n')}\n});\n\nconst data = await response.json();\nconsole.log(data);`;
  }, [endpoint, requestUrl, authMode, apiKey, requestBody]);

  const handleCopy = useCallback(async (text: string, setter: (v: boolean) => void) => {
    await navigator.clipboard.writeText(text);
    setter(true);
    setTimeout(() => setter(false), 2000);
  }, []);

  const handleTryIt = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResponse(null);
    setResponseStatus(null);

    try {
      const headers: Record<string, string> = {};
      if (authMode === 'apikey' && apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      if (endpoint.method === 'POST') {
        headers['Content-Type'] = 'application/json';
      }

      const fetchOpts: RequestInit = {
        method: endpoint.method,
        headers,
      };
      if (endpoint.method === 'POST' && requestBody) {
        fetchOpts.body = JSON.stringify(requestBody);
      }

      const res = await fetch(requestUrl, fetchOpts);
      setResponseStatus(res.status);
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        setResponse(JSON.stringify(json, null, 2));
      } catch {
        setResponse(text);
      }
    } catch (err) {
      if (err instanceof TypeError) {
        setError(L.SANDBOX_ERROR_UNREACHABLE);
      } else {
        setError(err instanceof Error ? err.message : 'Request failed');
      }
    } finally {
      setLoading(false);
    }
  }, [authMode, apiKey, endpoint, requestUrl, requestBody]);

  return (
    <div className="space-y-6">
      {/* Endpoint Selector */}
      <div className="relative">
        <label className="block text-[10px] uppercase tracking-[0.2em] text-[#bbc9cf] font-semibold mb-2">
          Endpoint
        </label>
        <button
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className="w-full flex items-center justify-between bg-[#192028] border border-[#3c494e]/30 rounded-lg px-4 py-3 text-left hover:border-[#00d4ff]/40 transition-colors"
        >
          <div className="flex items-center gap-3">
            <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${
              endpoint.method === 'GET' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-blue-500/20 text-blue-400'
            }`}>
              {endpoint.method}
            </span>
            <span className="font-mono text-sm text-[#dce3ed]">{endpoint.path}</span>
            <span className="text-xs text-[#bbc9cf] hidden sm:inline">({endpoint.price})</span>
          </div>
          <ChevronDown className={`h-4 w-4 text-[#bbc9cf] transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
        </button>
        {dropdownOpen && (
          <div className="absolute z-50 mt-1 w-full bg-[#192028] border border-[#3c494e]/30 rounded-lg shadow-xl overflow-hidden">
            {ENDPOINTS.map((ep) => (
              <button
                key={ep.id}
                onClick={() => handleSelectEndpoint(ep.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[#242b32] transition-colors ${
                  ep.id === selectedEndpoint ? 'bg-[#242b32] border-l-2 border-[#00d4ff]' : ''
                }`}
              >
                <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${
                  ep.method === 'GET' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-blue-500/20 text-blue-400'
                }`}>
                  {ep.method}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm text-[#dce3ed] truncate">{ep.path}</div>
                  <div className="text-xs text-[#bbc9cf] truncate">{ep.description}</div>
                </div>
                <span className="text-xs text-[#859398] font-mono shrink-0">{ep.price}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Auth Section */}
      <div>
        <label className="block text-[10px] uppercase tracking-[0.2em] text-[#bbc9cf] font-semibold mb-2">
          Authentication
        </label>
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => setAuthMode('apikey')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
              authMode === 'apikey'
                ? 'bg-[#00d4ff]/15 text-[#00d4ff] border border-[#00d4ff]/40'
                : 'bg-[#192028] text-[#bbc9cf] border border-[#3c494e]/30 hover:border-[#3c494e]/50'
            }`}
          >
            <Key className="h-4 w-4" />
            API Key
          </button>
          <button
            onClick={() => setAuthMode('x402')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
              authMode === 'x402'
                ? 'bg-[#00d4ff]/15 text-[#00d4ff] border border-[#00d4ff]/40'
                : 'bg-[#192028] text-[#bbc9cf] border border-[#3c494e]/30 hover:border-[#3c494e]/50'
            }`}
          >
            <CreditCard className="h-4 w-4" />
            x402 Payment
          </button>
        </div>
        {authMode === 'apikey' ? (
          <>
            <input
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="API key (e.g. ark_live_...)"
              className="w-full bg-[#080f16] border border-[#3c494e]/30 rounded-lg px-4 py-2.5 font-mono text-sm text-[#dce3ed] placeholder:text-[#3c494e] focus:outline-none focus:border-[#00d4ff]/50 transition-colors"
            />
            {!apiKey && (
              <p className="mt-2 text-xs text-[#bbc9cf]">
                {L.SANDBOX_ANON_HINT}{' '}
                <a href={ROUTES.SIGNUP} className="text-[#00d4ff] hover:underline">{L.SANDBOX_ANON_HINT_CTA}</a>{' '}
                {L.SANDBOX_ANON_HINT_SUFFIX}
              </p>
            )}
          </>
        ) : (
          <div className="bg-[#080f16] border border-[#3c494e]/30 rounded-lg p-4 text-sm text-[#bbc9cf] space-y-2">
            <p className="text-[#a8e8ff] font-semibold">x402 Payment Protocol</p>
            <p>No API key needed. Make a request without auth and receive a <code className="text-[#00d4ff]">402 Payment Required</code> response with pricing details. Complete the USDC payment on Base L2, then retry with the <code className="text-[#00d4ff]">X-Payment</code> header containing your transaction proof.</p>
          </div>
        )}
      </div>

      {/* Parameters Panel */}
      {endpoint.params.length > 0 && (
        <div>
          <label className="block text-[10px] uppercase tracking-[0.2em] text-[#bbc9cf] font-semibold mb-2">
            Parameters
          </label>
          <div className="space-y-3">
            {endpoint.params.map((param) => (
              <div key={param.name}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-[#a8e8ff]">{param.name}</span>
                  {param.required && (
                    <span className="text-[9px] uppercase tracking-wider text-amber-400 font-bold">required</span>
                  )}
                </div>
                {param.type === 'select' ? (
                  <select
                    value={paramValues[param.name] || ''}
                    onChange={(e) => setParam(param.name, e.target.value)}
                    className="w-full bg-[#080f16] border border-[#3c494e]/30 rounded-lg px-4 py-2.5 font-mono text-sm text-[#dce3ed] focus:outline-none focus:border-[#00d4ff]/50 transition-colors"
                  >
                    <option value="">Select...</option>
                    {param.options?.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={paramValues[param.name] || ''}
                    onChange={(e) => setParam(param.name, e.target.value)}
                    placeholder={param.placeholder}
                    className="w-full bg-[#080f16] border border-[#3c494e]/30 rounded-lg px-4 py-2.5 font-mono text-sm text-[#dce3ed] placeholder:text-[#3c494e] focus:outline-none focus:border-[#00d4ff]/50 transition-colors"
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Request Builder — curl */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] uppercase tracking-[0.2em] text-[#bbc9cf] font-semibold">
            curl
          </label>
          <button
            onClick={() => handleCopy(curlCommand, setCopiedCurl)}
            className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-[#bbc9cf] hover:text-[#00d4ff] transition-colors"
          >
            {copiedCurl ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copiedCurl ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="bg-[#080f16] border border-[#3c494e]/15 rounded-lg p-4 font-mono text-xs text-[#a8e8ff] overflow-x-auto whitespace-pre leading-relaxed">
          {curlCommand}
        </pre>
      </div>

      {/* Request Builder — fetch */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[10px] uppercase tracking-[0.2em] text-[#bbc9cf] font-semibold">
            JavaScript (fetch)
          </label>
          <button
            onClick={() => handleCopy(fetchCode, setCopiedFetch)}
            className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-[#bbc9cf] hover:text-[#00d4ff] transition-colors"
          >
            {copiedFetch ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copiedFetch ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="bg-[#080f16] border border-[#3c494e]/15 rounded-lg p-4 font-mono text-xs text-[#a8e8ff] overflow-x-auto whitespace-pre leading-relaxed">
          {fetchCode}
        </pre>
      </div>

      {/* Try It Button */}
      <button
        onClick={handleTryIt}
        disabled={loading}
        className="w-full flex items-center justify-center gap-2 bg-[#00d4ff] text-[#003642] font-bold uppercase tracking-widest text-sm py-3.5 rounded-lg hover:shadow-[0_0_25px_rgba(0,212,255,0.4)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Sending...
          </>
        ) : (
          <>
            <Play className="h-4 w-4" />
            Try It
          </>
        )}
      </button>

      {/* Response Panel */}
      {(response || error) && (
        <div>
          <div className="flex items-center gap-3 mb-2">
            <label className="text-[10px] uppercase tracking-[0.2em] text-[#bbc9cf] font-semibold">
              Response
            </label>
            {responseStatus !== null && (
              <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${
                responseStatus >= 200 && responseStatus < 300
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : responseStatus >= 400 && responseStatus < 500
                  ? 'bg-amber-500/20 text-amber-400'
                  : 'bg-red-500/20 text-red-400'
              }`}>
                {responseStatus}
              </span>
            )}
          </div>
          {error ? (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
              <div className="text-sm text-red-300">{error}</div>
            </div>
          ) : (
            <pre className="bg-[#080f16] border border-[#3c494e]/15 rounded-lg p-4 font-mono text-xs text-[#dce3ed] overflow-x-auto whitespace-pre leading-relaxed max-h-[500px] overflow-y-auto">
              {response}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
