export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  execute: (input: unknown) => Promise<unknown>;
}

export interface ModelContext {
  registerTool: (
    tool: WebMcpTool,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown> | unknown;
}

type Navigate = (path: string) => void;

function asInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool input must be an object');
  }
  return value as Record<string, unknown>;
}

function requiredString(
  input: Record<string, unknown>,
  field: string,
  maximumLength: number,
  pattern?: RegExp,
): string {
  const value = input[field];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximumLength) {
    throw new Error(`${field} must be a non-empty string of at most ${maximumLength} characters`);
  }
  const normalized = value.trim();
  if (pattern && !pattern.test(normalized)) {
    throw new Error(`${field} has an invalid format`);
  }
  return normalized;
}

export function registerArkovaWebMcpTools(
  modelContext: ModelContext,
  navigate: Navigate,
): AbortController {
  const controller = new AbortController();
  const options = { signal: controller.signal };

  void modelContext.registerTool({
    name: 'search_arkova',
    description: 'Open Arkova search with a bounded natural-language query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 200 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async input => {
      const query = requiredString(asInput(input), 'query', 200);
      navigate(`/search?${new URLSearchParams({ q: query }).toString()}`);
      return { content: [{ type: 'text', text: 'Opened Arkova search.' }] };
    },
  }, options);

  void modelContext.registerTool({
    name: 'verify_arkova_record',
    description: 'Open the public Arkova verification page for a public record ID.',
    inputSchema: {
      type: 'object',
      properties: {
        public_id: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: '^[A-Za-z0-9_-]+$',
        },
      },
      required: ['public_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async input => {
      const publicId = requiredString(asInput(input), 'public_id', 128, /^[A-Za-z0-9_-]+$/);
      navigate(`/verify/${encodeURIComponent(publicId)}`);
      return { content: [{ type: 'text', text: 'Opened Arkova public verification.' }] };
    },
  }, options);

  return controller;
}

export function registerArkovaWebMcpOnPage(
  targetNavigator: Navigator = navigator,
  targetDocument: Document = document,
): AbortController | undefined {
  // Chrome's current experiment exposes navigator.modelContext, while the
  // emerging specification also documents document.modelContext. Supporting
  // both keeps registration progressive and avoids duplicate tools.
  const navigatorContext = (targetNavigator as Navigator & { modelContext?: ModelContext }).modelContext;
  const documentContext = (targetDocument as Document & { modelContext?: ModelContext }).modelContext;
  const modelContext = navigatorContext ?? documentContext;
  if (!modelContext || typeof modelContext.registerTool !== 'function') return undefined;

  return registerArkovaWebMcpTools(modelContext, path => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}
