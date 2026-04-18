const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, PageNumber, PageBreak, LevelFormat, TableOfContents,
  ExternalHyperlink,
} = require("docx");

// ── Design tokens ───────────────────────────────────────────────────────────
const NAVY = "0A1628";
const CYAN = "0891B2";
const DARK_CYAN = "065F73";
const LIGHT_BG = "F0F9FF";
const MED_BG = "E0F2FE";
const WHITE = "FFFFFF";
const GRAY_TEXT = "4B5563";
const DARK_TEXT = "111827";
const BORDER_CLR = "CBD5E1";
const HEADER_BG = "0E2A47";

const PAGE_W = 12240; // US Letter
const PAGE_H = 15840;
const MARGIN = 1440; // 1 inch
const CONTENT_W = PAGE_W - MARGIN * 2; // 9360

// ── Helpers ─────────────────────────────────────────────────────────────────
const border = { style: BorderStyle.SINGLE, size: 1, color: BORDER_CLR };
const borders = { top: border, bottom: border, left: border, right: border };
const noBorders = {
  top: { style: BorderStyle.NONE, size: 0 },
  bottom: { style: BorderStyle.NONE, size: 0 },
  left: { style: BorderStyle.NONE, size: 0 },
  right: { style: BorderStyle.NONE, size: 0 },
};
const cellMargins = { top: 60, bottom: 60, left: 100, right: 100 };

function headerCell(text, width) {
  return new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    shading: { fill: HEADER_BG, type: ShadingType.CLEAR },
    margins: cellMargins,
    verticalAlign: "center",
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: WHITE, font: "Arial", size: 19 })] })],
  });
}

function cell(children, width, opts = {}) {
  const runs = typeof children === "string"
    ? [new TextRun({ text: children, font: "Arial", size: 19, color: DARK_TEXT, ...opts.runOpts })]
    : children;
  return new TableCell({
    borders,
    width: { size: width, type: WidthType.DXA },
    shading: opts.shading ? { fill: opts.shading, type: ShadingType.CLEAR } : undefined,
    margins: cellMargins,
    children: [new Paragraph({ children: runs, spacing: { before: 20, after: 20 } })],
  });
}

function boldCell(text, width, opts = {}) {
  return cell([new TextRun({ text, bold: true, font: "Arial", size: 19, color: DARK_TEXT })], width, opts);
}

function makeTable(headers, rows, colWidths) {
  const totalW = colWidths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: totalW, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [
      new TableRow({ children: headers.map((h, i) => headerCell(h, colWidths[i])) }),
      ...rows.map((row, ri) =>
        new TableRow({
          children: row.map((c, ci) => {
            if (typeof c === "object" && c._isBold) return boldCell(c.text, colWidths[ci], { shading: ri % 2 === 1 ? LIGHT_BG : undefined });
            return cell(c, colWidths[ci], { shading: ri % 2 === 1 ? LIGHT_BG : undefined });
          }),
        })
      ),
    ],
  });
}

const B = (text) => ({ text, _isBold: true });

function h1(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 }, children: [new TextRun({ text, color: NAVY })] });
}
function h2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 150 }, children: [new TextRun({ text, color: DARK_CYAN })] });
}
function h3(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_3, spacing: { before: 240, after: 120 }, children: [new TextRun({ text, color: CYAN })] });
}
function para(...runs) {
  return new Paragraph({ spacing: { after: 160, line: 276 }, children: runs });
}
function t(text, opts = {}) {
  return new TextRun({ text, font: "Arial", size: 21, color: DARK_TEXT, ...opts });
}
function tb(text, opts = {}) {
  return t(text, { bold: true, ...opts });
}
function mono(text) {
  return new TextRun({ text, font: "Courier New", size: 19, color: CYAN });
}
function spacer(pts = 120) {
  return new Paragraph({ spacing: { before: pts, after: 0 }, children: [] });
}
function bullet(text, ref = "bullets", level = 0) {
  return new Paragraph({
    numbering: { reference: ref, level },
    spacing: { after: 80, line: 276 },
    children: [t(text)],
  });
}
function bulletRuns(runs, ref = "bullets", level = 0) {
  return new Paragraph({
    numbering: { reference: ref, level },
    spacing: { after: 80, line: 276 },
    children: runs,
  });
}
function numberedItem(text, ref = "numbers", level = 0) {
  return new Paragraph({
    numbering: { reference: ref, level },
    spacing: { after: 80, line: 276 },
    children: [t(text)],
  });
}
function codeBlock(lines) {
  return lines.map(line =>
    new Paragraph({
      spacing: { after: 0, line: 240 },
      indent: { left: 360 },
      shading: { fill: "F1F5F9", type: ShadingType.CLEAR },
      children: [new TextRun({ text: line, font: "Courier New", size: 17, color: "334155" })],
    })
  );
}
function calloutBox(title, text) {
  return [
    new Paragraph({
      spacing: { before: 200, after: 80 },
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: CYAN, space: 8 } },
      indent: { left: 200 },
      children: [tb(title, { color: CYAN, size: 21 })],
    }),
    new Paragraph({
      spacing: { after: 200 },
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: CYAN, space: 8 } },
      indent: { left: 200 },
      children: [t(text, { size: 19, color: GRAY_TEXT })],
    }),
  ];
}
function divider() {
  return new Paragraph({
    spacing: { before: 240, after: 240 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_CLR, space: 1 } },
    children: [],
  });
}

// ── BUILD DOCUMENT ──────────────────────────────────────────────────────────
const doc = new Document({
  styles: {
    default: { document: { run: { font: "Arial", size: 21, color: DARK_TEXT } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, font: "Arial", color: NAVY },
        paragraph: { spacing: { before: 400, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial", color: DARK_CYAN },
        paragraph: { spacing: { before: 300, after: 150 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, font: "Arial", color: CYAN },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 2 } },
    ],
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [
        { level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
        { level: 1, format: LevelFormat.BULLET, text: "\u2013", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 1080, hanging: 360 } } } },
      ]},
      { reference: "numbers", levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
      ]},
      { reference: "toc-numbers", levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
      ]},
    ],
  },
  sections: [
    // ════════════════════════════════════════════════════════════════════════
    // COVER PAGE
    // ════════════════════════════════════════════════════════════════════════
    {
      properties: {
        page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } },
      },
      children: [
        spacer(2400),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 }, children: [
          new TextRun({ text: "ARKOVA", font: "Arial", size: 72, bold: true, color: NAVY }),
        ]}),
        spacer(80),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 0 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: CYAN, space: 12 } },
          children: [new TextRun({ text: "Technical & Security Wiki", font: "Arial", size: 36, color: CYAN })],
        }),
        spacer(300),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: [
          t("For Partners, Investors, and Integration Teams", { size: 24, color: GRAY_TEXT }),
        ]}),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: [
          t("Version 1.0  |  March 2026  |  Confidential", { size: 20, color: GRAY_TEXT }),
        ]}),
        spacer(1200),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [
          t("Jurisdiction-Aware Verification Layer Anchored to Bitcoin", { size: 22, color: DARK_CYAN, italics: true }),
        ]}),
      ],
    },
    // ════════════════════════════════════════════════════════════════════════
    // TABLE OF CONTENTS
    // ════════════════════════════════════════════════════════════════════════
    {
      properties: {
        page: { size: { width: PAGE_W, height: PAGE_H }, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } },
      },
      headers: {
        default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [
          new TextRun({ text: "ARKOVA  |  Technical & Security Wiki", font: "Arial", size: 16, color: GRAY_TEXT, italics: true }),
        ]})] }),
      },
      footers: {
        default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
          new TextRun({ text: "Confidential  |  Page ", font: "Arial", size: 16, color: GRAY_TEXT }),
          new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 16, color: GRAY_TEXT }),
        ]})] }),
      },
      children: [
        h1("Table of Contents"),
        spacer(60),
        new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-3" }),
        new Paragraph({ children: [new PageBreak()] }),

        // ══════════════════════════════════════════════════════════════════
        // SECTION 1: SYSTEM OVERVIEW & ARCHITECTURE
        // ══════════════════════════════════════════════════════════════════
        h1("1. System Overview & Architecture"),

        h2("What Arkova Is"),
        para(
          t("Arkova is a "), tb("jurisdiction-aware verification layer"),
          t(" that enables organizations to issue, anchor, and verify credentials against the Bitcoin blockchain. It transforms documents such as diplomas, certificates, licenses, attestations, and compliance records into tamper-evident digital credentials \u2014 without ever taking custody of the underlying documents."),
        ),
        para(
          t("Arkova is "), tb("not"), t(" a blockchain company. It is a "),
          tb("verification infrastructure"), t(" company that uses Bitcoin as an immutable timestamping layer. The platform abstracts away all chain complexity, presenting a clean enterprise SaaS interface to issuers, holders, and verifiers."),
        ),

        h2("The Verification Layer Concept"),
        para(t("Traditional credential verification relies on phone calls, manual lookups, and paper trails. Arkova replaces this with a three-party model:")),
        spacer(60),
        // Simplified diagram as a table
        makeTable(
          ["Party", "Role", "Action"],
          [
            [B("Issuer"), "University, employer, regulator, certifying body", "Uploads credential; document fingerprinted (SHA-256) entirely on-device. Only the fingerprint leaves the browser."],
            [B("Arkova"), "Verification layer", "Anchors fingerprint to Bitcoin via OP_RETURN (ARKV prefix + SHA-256 hash = 36 bytes)."],
            [B("Verifier"), "Employer, regulator, AI agent, ATS system", "Queries API or public verification page to confirm authenticity, timestamp, issuer, and status."],
          ],
          [1800, 3000, 4560],
        ),

        h2("Non-Custodial Architecture"),
        para(t("Arkova is "), tb("strictly non-custodial"), t(" across three dimensions:")),
        spacer(60),
        makeTable(
          ["Dimension", "What This Means"],
          [
            [B("Document Non-Custody"), "Documents never leave the user\u2019s device. Arkova never receives, stores, transmits, or processes raw document content. Only a one-way SHA-256 fingerprint is stored."],
            [B("Financial Non-Custody"), "Arkova does not store, accept, or manage user cryptocurrency. All on-chain fees are paid from an Arkova-managed corporate fee account. Users never interact with chain economics."],
            [B("Key Non-Custody"), "Treasury signing keys are secured in GCP Cloud KMS (HSM-backed). No human has access to raw private key material."],
          ],
          [2800, 6560],
        ),
        spacer(80),
        para(t("This design eliminates regulated data custody risk. Arkova does not become a custodian of PII, financial assets, or cryptographic material \u2014 removing exposure to GDPR data processor obligations, money transmitter classification, and key management liability.")),

        h2("Schema-First Build Philosophy"),
        para(t("Every feature begins at the database layer:")),
        numberedItem("Schema First \u2014 Define Postgres tables, columns, constraints, and Row Level Security policies before writing any application code."),
        numberedItem("Migration Immutability \u2014 Once a migration is applied, it is never modified. Changes are expressed as compensating migrations."),
        numberedItem("Type Generation \u2014 TypeScript types are auto-generated from the database schema, ensuring compile-time safety across the full stack."),
        numberedItem("Validation at the Boundary \u2014 All write paths are validated with Zod schemas before reaching the database. No trust is placed in client-supplied data."),
        spacer(60),
        para(t("This philosophy ensures the database is always the single source of truth, type drift is impossible, and schema evolution is auditable.")),

        new Paragraph({ children: [new PageBreak()] }),
        // ══════════════════════════════════════════════════════════════════
        // SECTION 2: SECURITY & PRIVACY
        // ══════════════════════════════════════════════════════════════════
        h1("2. Security & Privacy"),

        h2("Mandatory Row Level Security (RLS)"),
        para(t("Every table in the Arkova database has "), mono("FORCE ROW LEVEL SECURITY"), t(" enabled. This is a non-negotiable architectural constraint \u2014 there are no exceptions.")),
        bullet("Even if application code has a bug, the database will refuse to return rows the authenticated user is not authorized to see."),
        bullet("RLS policies apply even to the table owner \u2014 a defense-in-depth measure against privilege escalation."),
        bulletRuns([t("All "), mono("SECURITY DEFINER"), t(" functions include "), mono("SET search_path = public"), t(" to prevent search path injection attacks.")]),
        spacer(60),
        makeTable(
          ["Table", "RLS Policy"],
          [
            [B("anchors"), "Users see own anchors + org anchors (via org membership)"],
            [B("profiles"), "Users see own profile only"],
            [B("organizations"), "Members see their own org"],
            [B("audit_events"), "Users see own events only"],
            [B("api_keys"), "ORG_ADMIN only (not readable by ORG_MEMBER)"],
            [B("webhook_endpoints"), "ORG_ADMIN full CRUD for own org"],
            [B("billing_events"), "User reads own; append-only (triggers block UPDATE/DELETE)"],
            [B("attestations"), "Public read; write restricted to authenticated users"],
          ],
          [2800, 6560],
        ),

        h2("Tenant Isolation"),
        para(t("Multi-tenancy is enforced at the database level, not the application level:")),
        bulletRuns([t("Every row carries an "), mono("org_id"), t(" foreign key. RLS policies use "), mono("auth.uid()"), t(" to resolve identity and "), mono("org_id"), t(" to scope access.")]),
        bulletRuns([t("Helper functions ("), mono("is_org_admin_of()"), t(", "), mono("get_user_org_ids()"), t(") are SECURITY DEFINER to avoid circular RLS dependencies.")]),
        bullet("Cross-tenant data access is architecturally impossible \u2014 the database will not return rows outside the caller\u2019s org scope, regardless of the query constructed."),

        h2("The Client-Side Processing Boundary"),
        ...calloutBox(
          "FOUNDATIONAL PRIVACY GUARANTEE",
          "Documents never leave the user\u2019s device. Arkova never receives, stores, transmits, or processes raw document content."
        ),
        para(tb("Data flow:")),
        numberedItem("Document is opened on user\u2019s device (browser)."),
        numberedItem("PDF.js / Tesseract.js performs OCR in a Web Worker \u2014 entirely client-side."),
        numberedItem("PII stripping (regex-based) removes SSNs, student IDs, DOB, emails, phones, and names."),
        numberedItem("SHA-256 fingerprint (32 bytes) is computed from the original document."),
        numberedItem("Only the PII-stripped metadata + fingerprint cross the network boundary to the server."),
        spacer(60),
        para(tb("Why this matters for partners and investors:")),
        bullet("Arkova is not a data processor under GDPR for document content. We never receive it."),
        bulletRuns([t("There is no \u201Craw mode\u201D bypass. The "), mono("ENABLE_AI_EXTRACTION"), t(" flag gates the entire pipeline.")]),
        bulletRuns([mono("generateFingerprint()"), t(" is architecturally prohibited from being imported in server-side code.")]),
        bullet("Partners integrating with Arkova do not need to assess Arkova as a document custodian in their vendor risk assessments."),

        h2("Audit Trail"),
        bullet("Immutable, append-only audit_events table. Database triggers reject all UPDATE and DELETE operations \u2014 even from service_role."),
        bullet("Event categories: AUTH, ANCHOR, PROFILE, ORG, ADMIN, SYSTEM."),
        bullet("PII fields (actor_email) are nullified at write time. Supports SOC 2 evidence collection."),

        h2("API Key Security"),
        bullet("Keys hashed with HMAC-SHA256. Raw keys never stored after initial creation."),
        bullet("Scoped permissions: verify, verify:batch, keys:manage, usage:read."),
        bullet("Key rotation does not require downtime."),

        h2("On-Chain Content Policy"),
        para(t("Only 36 bytes are ever written to Bitcoin: "), mono("ARKV"), t(" (4 bytes) + SHA-256 hash (32 bytes). Filenames, file sizes, MIME types, user IDs, org IDs, email addresses, and any PII are "), tb("explicitly forbidden"), t(" from on-chain transactions.")),

        new Paragraph({ children: [new PageBreak()] }),
        // ══════════════════════════════════════════════════════════════════
        // SECTION 3: TERMINOLOGY & COMPLIANCE
        // ══════════════════════════════════════════════════════════════════
        h1("3. Terminology & Compliance"),

        h2("Strict Enterprise Terminology"),
        para(t("Arkova maintains a strict terminology policy to ensure all user-facing language is appropriate for enterprise, legal, and regulatory audiences. This policy is CI-enforced.")),
        spacer(60),
        makeTable(
          ["Banned Term", "Required Alternative", "Rationale"],
          [
            [B("Wallet"), "Fee Account / Billing Account", "Avoids confusion with custodial cryptocurrency wallets"],
            [B("Transaction"), "Network Receipt / Anchor Receipt", "Prevents association with financial transactions"],
            [B("Hash"), "Fingerprint", "Enterprise-friendly; conveys intent without jargon"],
            [B("Block"), "Network Confirmation", "Avoids blockchain-specific terminology"],
            [B("Blockchain / Bitcoin"), "Anchoring Network / Production Network", "Keeps messaging technology-neutral"],
            [B("Testnet / Mainnet"), "Test Environment / Production Network", "Standard enterprise environment naming"],
            [B("Gas"), "Network Fee", "Not applicable (OP_RETURN model), but reserved"],
            [B("UTXO / Broadcast"), "(internal only)", "No user-visible equivalent needed"],
          ],
          [2400, 3400, 3560],
        ),

        h2("Credential Types"),
        spacer(60),
        makeTable(
          ["Type", "Examples"],
          [
            [B("DIPLOMA"), "University degrees, academic diplomas"],
            [B("CERTIFICATE"), "Professional certifications, course completions"],
            [B("LICENSE"), "Professional licenses, regulatory permits"],
            [B("BADGE"), "Digital badges, micro-credentials"],
            [B("ATTESTATION"), "Third-party attestation claims"],
            [B("FINANCIAL"), "Financial compliance documents"],
            [B("LEGAL"), "Legal agreements, contracts"],
            [B("INSURANCE"), "Insurance certificates, COIs"],
            [B("SEC_FILING"), "SEC regulatory filings"],
            [B("PATENT"), "Patent filings and grants"],
            [B("REGULATION"), "Regulatory documents"],
            [B("PUBLICATION"), "Academic publications"],
            [B("OTHER"), "General-purpose catch-all"],
          ],
          [2400, 6960],
        ),

        h2("Compliance Posture"),
        spacer(60),
        makeTable(
          ["Requirement", "Arkova\u2019s Approach"],
          [
            [B("GDPR"), "Non-custodial for documents. Fingerprints are one-way hashes; originals cannot be recovered. Account deletion (right to erasure) implemented with full cascade."],
            [B("SOC 2"), "Evidence collection documented. Branch protection, RLS, audit trails, and key management provide CC6.1/CC6.3/CC7.2 controls."],
            [B("Data Retention"), "Configurable retention policies. cleanup_expired_data RPC runs on schedule. Legal hold overrides prevent deletion when active."],
            [B("CCPA"), "Account deletion cascade covers all personal data. No sale of personal information."],
          ],
          [2000, 7360],
        ),

        new Paragraph({ children: [new PageBreak()] }),
        // ══════════════════════════════════════════════════════════════════
        // SECTION 4: AI INTELLIGENCE SUITE
        // ══════════════════════════════════════════════════════════════════
        h1("4. AI Intelligence Suite"),

        h2("Overview"),
        para(t("Arkova\u2019s AI Intelligence Suite provides automated credential extraction, fraud detection, semantic search, and compliance analysis \u2014 all while respecting the client-side processing boundary. The AI operates exclusively on "), tb("PII-stripped metadata"), t(", never on raw document content.")),

        h2("Capabilities"),
        spacer(60),
        makeTable(
          ["Capability", "Description", "Endpoint"],
          [
            [B("Metadata Extraction"), "Extracts structured fields from PII-stripped OCR text using Gemini Flash. Returns confidence scores.", "POST /ai/extract"],
            [B("Batch Extraction"), "Process multiple credentials in a single request (up to 100).", "POST /ai/extract/batch"],
            [B("Semantic Search"), "Natural language search across all credentials using pgvector embeddings (768-dim).", "GET /ai/search"],
            [B("Fraud / Integrity"), "Computes 0-100 integrity score. Scores below 60 auto-flagged for human review.", "POST /ai/integrity/compute"],
            [B("Visual Fraud Detection"), "Image-based fraud analysis for credential documents.", "POST /ai/fraud/visual"],
            [B("Human Review Queue"), "Flagged credentials surface in admin review queue.", "GET /ai/review"],
            [B("Extraction Feedback"), "Closed-loop learning: human corrections improve future accuracy.", "POST /ai/feedback"],
            [B("RAG Query (Nessie)"), "Retrieval-augmented generation against 29,000+ public records. Cited sources.", "POST /nessie/query"],
            [B("Compliance Check"), "Entity-level compliance risk scoring against regulatory records.", "POST /compliance/check"],
            [B("Entity Verification"), "Cross-reference entities against EDGAR, Federal Register, DAPIP, OpenAlex.", "GET /verify/entity"],
          ],
          [2200, 4560, 2600],
        ),

        h2("Cost-Efficiency Model"),
        spacer(60),
        makeTable(
          ["Operation", "Cost", "Model"],
          [
            ["Metadata Extraction", "1 AI credit", "Gemini 2.0 Flash"],
            ["Semantic Search", "1 AI credit", "text-embedding-004"],
            ["Fraud Analysis", "5 AI credits", "Gemini 2.0 Flash"],
            ["Embedding Generation", "1 AI credit", "text-embedding-004"],
            ["RAG Query (Nessie)", "Variable", "Gemini 2.0 Flash + pgvector"],
          ],
          [3120, 2400, 3840],
        ),
        spacer(60),
        para(tb("Why Gemini Flash: "), t("At ~$0.075 per 1M input tokens, Gemini Flash provides extraction accuracy on par with larger models (F1=82.1% on our golden dataset of 2,050+ entries) at a fraction of the cost. The provider abstraction layer supports hot-swapping to OpenAI or Anthropic.")),

        h2("Public Data Pipeline"),
        spacer(60),
        makeTable(
          ["Source", "Content", "Update Frequency"],
          [
            [B("SEC EDGAR"), "Regulatory filings", "Continuous"],
            [B("Federal Register"), "Regulatory actions", "Continuous"],
            [B("DAPIP"), "Institutional data (Dept. of Education)", "Batch (resumable)"],
            [B("OpenAlex"), "Academic publications", "Every 30 minutes"],
            [B("Total"), "29,000+ records, 9,300+ embeddings", "Auto-growing via Cloud Scheduler"],
          ],
          [2400, 4160, 2800],
        ),

        new Paragraph({ children: [new PageBreak()] }),
        // ══════════════════════════════════════════════════════════════════
        // SECTION 5: ROADMAP & EVOLUTION
        // ══════════════════════════════════════════════════════════════════
        h1("5. Roadmap & Evolution"),

        h2("Three-Phase Product Evolution"),
        spacer(60),
        makeTable(
          ["Phase", "Name", "Status", "Description"],
          [
            [B("Phase 1"), "Credentialing MVP", "Live (94%)", "Issue, anchor, verify, search credentials. Bitcoin anchoring. AI extraction. Verification API. Webhooks. Stripe payments."],
            [B("Phase 1.5"), "Foundation", "In Progress", "Public records pipeline, x402 micropayments (USDC on Base L2), Nessie RAG, SDKs, multi-chain support."],
            [B("Phase 2"), "Attestations", "Planned", "Third-party attestation claims. Full lifecycle: create, verify, expire, revoke. Anchoring to Bitcoin."],
            [B("Phase 3"), "E-Signatures", "Planned", "Legally recognized electronic signatures layered on anchoring infrastructure."],
          ],
          [1400, 2000, 1600, 4360],
        ),

        h2("Detailed Milestone Roadmap"),
        spacer(60),
        makeTable(
          ["Milestone", "Target", "Key Deliverables"],
          [
            ["Beta Launch (Signet)", "Complete", "1,572+ SECURED anchors, 13 beta stories, 2,236 tests"],
            ["Bitcoin Mainnet Window", "Q2 2026", "Mainnet treasury funding, batch anchoring, production chain receipts"],
            ["Base L2 Anchoring", "Q2 2026", "Multi-chain support via Base (lower cost, faster confirmations)"],
            ["Attestation API (v1)", "Q2 2026", "5 attestation types, revocation, expiry, CRUD API"],
            ["x402 Micropayments", "Q2 2026", "USDC on Base L2, pay-per-call API access"],
            ["Python & TS SDKs", "Q2 2026", "Partner integration libraries with full API coverage"],
            ["Golden Dataset 2,000+", "Q2 2026", "Comprehensive AI evaluation across all credential types"],
            ["Nessie RAG v1", "Q2 2026", "Natural language queries against 30K+ records"],
            ["CLE Verification", "Q3 2026", "Continuing Legal Education credit verification"],
            ["E-Signature Layer", "Q4 2026", "Legally binding signatures anchored to Bitcoin"],
          ],
          [2800, 1600, 4960],
        ),

        h2("Infrastructure Metrics (Current)"),
        spacer(60),
        makeTable(
          ["Metric", "Value"],
          [
            ["Database Migrations", "121"],
            ["Test Suite", "2,433+ (1,024 frontend + 1,409 worker)"],
            ["Stories Completed", "180 / 192 (94%)"],
            ["Security Audit Findings", "24 / 24 resolved (100%)"],
            ["SECURED Anchors", "1,572+"],
            ["Public Records Indexed", "29,000+"],
            ["Vector Embeddings", "9,300+"],
            ["AI Eval F1 Score", "82.1%"],
          ],
          [4680, 4680],
        ),

        new Paragraph({ children: [new PageBreak()] }),
        // ══════════════════════════════════════════════════════════════════
        // SECTION 6: DEVELOPER REFERENCE
        // ══════════════════════════════════════════════════════════════════
        h1("6. Developer Reference"),

        h2("Technology Stack"),
        spacer(60),
        makeTable(
          ["Layer", "Technology", "Purpose"],
          [
            [B("Frontend"), "React 18 + TypeScript", "Single-page application"],
            [B("Styling"), "Tailwind CSS + shadcn/ui", "Component library and design system"],
            [B("Icons"), "Lucide React", "Consistent icon set"],
            [B("Bundler"), "Vite", "Development and production builds"],
            [B("Routing"), "react-router-dom v6", "Client-side routing with named routes"],
            [B("Database"), "Supabase (Postgres)", "Managed Postgres with auth, realtime, RLS"],
            [B("Auth"), "Supabase Auth", "Email/password, Google OAuth, MFA/TOTP"],
            [B("Worker"), "Node.js + Express", "Webhooks, anchoring, cron, AI processing"],
            [B("Validation"), "Zod", "Runtime schema validation on all write paths"],
            [B("Payments"), "Stripe (SDK + webhooks)", "Subscription billing (worker-only)"],
            [B("Micropayments"), "x402 (USDC on Base L2)", "Pay-per-call API access"],
            [B("Chain (Bitcoin)"), "bitcoinjs-lib + Cloud HSM", "OP_RETURN anchoring, HSM signing"],
            [B("Chain (Base L2)"), "viem", "EVM-based anchoring (calldata)"],
            [B("AI (Primary)"), "Gemini 2.0 Flash", "Extraction, fraud, RAG"],
            [B("AI (Fallback)"), "Cloudflare Workers AI", "Gated by ENABLE_AI_FALLBACK"],
            [B("Vector Search"), "pgvector", "768-dim embeddings for semantic search"],
            [B("Testing"), "Vitest + Playwright", "Unit, integration, RLS, E2E tests"],
            [B("Formal Verify"), "TLA PreCheck", "State machine correctness proofs"],
            [B("Observability"), "Sentry", "Error tracking (PII scrubbing mandatory)"],
            [B("Edge"), "Cloudflare Workers", "MCP server, queue processing"],
            [B("Ingress"), "Cloudflare Tunnel", "Zero Trust, no public ports"],
            [B("CI/CD"), "GitHub Actions \u2192 Vercel + Railway", "Automated deploy on merge"],
          ],
          [2000, 3360, 4000],
        ),

        h2("Webhook Reliability Standards"),
        spacer(60),
        makeTable(
          ["Standard", "Specification"],
          [
            [B("Delivery Protocol"), "HTTPS only (enforced by database CHECK constraint)"],
            [B("Signature"), "HMAC-SHA256 on full payload. X-Arkova-Signature header."],
            [B("Timestamp"), "ISO 8601 UTC in X-Arkova-Timestamp header"],
            [B("Event Type"), "X-Arkova-Event header (e.g., anchor.secured)"],
            [B("Retry Policy"), "5 attempts: immediate \u2192 1m \u2192 5m \u2192 30m \u2192 2h"],
            [B("Circuit Breaker"), "Consecutive failures trip circuit. Endpoint disabled. Probe after cooldown."],
            [B("Dead Letter Queue"), "After all retries, events retained 30 days. Manual replay available."],
            [B("Timeout"), "30-second delivery timeout"],
            [B("Rate Limit"), "100 deliveries/minute per organization"],
            [B("SSRF Protection"), "Private IPs blocked, DNS validated, metadata endpoints blocked"],
            [B("Idempotency"), "idempotency_key prevents duplicate processing"],
          ],
          [2400, 6960],
        ),

        h2("Webhook Events"),
        spacer(60),
        makeTable(
          ["Event", "Trigger"],
          [
            [B("anchor.created"), "New credential anchor created"],
            [B("anchor.secured"), "Anchor confirmed on Bitcoin network"],
            [B("anchor.revoked"), "Credential revoked"],
            [B("anchor.verified"), "Verification lookup performed"],
            [B("attestation.created"), "New attestation claim created"],
            [B("attestation.revoked"), "Attestation revoked"],
          ],
          [3120, 6240],
        ),

        h2("Authentication Methods"),
        spacer(60),
        makeTable(
          ["Method", "Use Case", "Header"],
          [
            [B("API Key (Bearer)"), "Verification API, batch ops", "Authorization: Bearer ak_live_..."],
            [B("API Key (Header)"), "Alternative delivery", "X-API-Key: ak_live_..."],
            [B("Supabase JWT"), "Key management, AI endpoints", "Authorization: Bearer eyJ..."],
            [B("x402 Payment"), "Pay-per-call (no subscription)", "HTTP 402 \u2192 USDC payment \u2192 retry"],
          ],
          [2400, 3200, 3760],
        ),

        h2("Rate Limiting"),
        spacer(60),
        makeTable(
          ["Scope", "Limit", "Response"],
          [
            ["Anonymous (public verification)", "100 req/min per IP", "HTTP 429 + Retry-After"],
            ["API Key holders", "1,000 req/min per key", "HTTP 429 + Retry-After"],
            ["Batch endpoints", "10 req/min per API key", "HTTP 429 + Retry-After"],
          ],
          [3500, 2800, 3060],
        ),

        new Paragraph({ children: [new PageBreak()] }),
        // ══════════════════════════════════════════════════════════════════
        // SECTION 7: API REFERENCE
        // ══════════════════════════════════════════════════════════════════
        h1("7. API Reference"),

        h2("Base URL & Documentation"),
        para(mono("https://{worker-host}/api/v1")),
        para(t("Interactive Swagger UI at "), mono("/api/docs"), t(". OpenAPI 3.0 spec at "), mono("/api/docs/spec.json"), t(".")),

        h2("Verification Endpoints"),
        spacer(60),
        makeTable(
          ["Method", "Endpoint", "Auth", "Description"],
          [
            [B("GET"), "/verify/{publicId}", "Optional", "Verify a single credential. Returns frozen verification schema."],
            [B("POST"), "/verify/batch", "API key", "Batch verify up to 100. Sync for \u226420, async for >20."],
            [B("GET"), "/verify/{publicId}/proof", "Optional", "Download cryptographic proof package."],
            [B("GET"), "/verify/entity", "API key / x402", "Cross-reference entity against public records."],
            [B("GET"), "/verify/search", "API key", "Agentic semantic search. For AI agents, ATS, background checks."],
            [B("GET"), "/jobs/{jobId}", "API key", "Poll async batch job status."],
            [B("GET"), "/usage", "API key", "Current month API usage across all org keys."],
          ],
          [1000, 2600, 1600, 4160],
        ),

        h2("Verification Response Schema (Frozen)"),
        para(t("The verification response schema is "), tb("frozen"), t(" \u2014 fields cannot be removed or renamed. Only additive nullable fields may be added.")),
        spacer(40),
        ...codeBlock([
          '{',
          '  "verified": true,',
          '  "status": "ACTIVE",',
          '  "issuer_name": "University of Michigan",',
          '  "recipient_identifier": "sha256:ab3f...",',
          '  "credential_type": "DIPLOMA",',
          '  "issued_date": "2026-01-15T00:00:00Z",',
          '  "expiry_date": null,',
          '  "anchor_timestamp": "2026-03-10T08:00:00Z",',
          '  "bitcoin_block": 204567,',
          '  "network_receipt_id": "b8e381df09ca404e...",',
          '  "record_uri": "https://app.arkova.io/verify/ARK-2026-001",',
          '  "jurisdiction": "US-MI"',
          '}',
        ]),
        spacer(60),
        para(tb("Status values: "), t("ACTIVE, REVOKED, SUPERSEDED, EXPIRED, PENDING")),
        para(tb("Key contract: "), mono("jurisdiction"), t(" is omitted when null \u2014 never returned as null.")),

        h2("Anchoring Endpoints"),
        spacer(60),
        makeTable(
          ["Method", "Endpoint", "Auth", "Description"],
          [
            [B("POST"), "/anchor", "API key / x402", "Submit fingerprint for Bitcoin anchoring. Idempotent."],
          ],
          [1000, 2600, 1600, 4160],
        ),

        h2("Attestation Endpoints"),
        spacer(60),
        makeTable(
          ["Method", "Endpoint", "Auth", "Description"],
          [
            [B("POST"), "/attestations", "JWT / API key", "Create an attestation claim for a credential."],
            [B("GET"), "/attestations", "Public", "List attestations with cursor-based pagination."],
            [B("GET"), "/attestations/{id}", "Public", "Retrieve a single attestation. Checks expiry."],
            [B("PATCH"), "/attestations/{id}/revoke", "Owner", "Revoke an attestation with optional reason."],
          ],
          [1000, 2600, 1600, 4160],
        ),
        spacer(40),
        para(tb("Attestation types: "), t("identity, employment, education, certification, compliance")),

        h2("Compliance Endpoints"),
        spacer(60),
        makeTable(
          ["Method", "Endpoint", "Auth", "Description"],
          [
            [B("POST"), "/compliance/check", "API key / x402", "Compliance risk scoring against regulatory records."],
            [B("GET"), "/regulatory/lookup", "API key / x402", "Search EDGAR, Federal Register, DAPIP, OpenAlex."],
            [B("GET"), "/cle/verify", "API key / x402", "Verify CLE credits by attorney/bar number/jurisdiction."],
            [B("GET"), "/cle/credits", "API key / x402", "Look up CLE credit balance."],
            [B("POST"), "/cle/submit", "API key", "Submit CLE course completion."],
            [B("GET"), "/cle/requirements", "Public", "Retrieve CLE requirements by jurisdiction."],
          ],
          [1000, 2600, 1600, 4160],
        ),

        h2("AI Intelligence Endpoints"),
        spacer(60),
        makeTable(
          ["Method", "Endpoint", "Auth", "Description"],
          [
            [B("POST"), "/ai/extract", "JWT", "Extract structured metadata. 1 AI credit."],
            [B("POST"), "/ai/extract/batch", "JWT", "Batch extraction for multiple credentials."],
            [B("POST"), "/ai/embed", "JWT", "Generate 768-dim pgvector embedding. 1 credit."],
            [B("POST"), "/ai/embed/batch", "JWT", "Batch embedding generation."],
            [B("GET"), "/ai/search", "JWT", "Natural language semantic search. 1 credit."],
            [B("POST"), "/ai/integrity/compute", "JWT", "Compute fraud/integrity score (0-100)."],
            [B("GET"), "/ai/integrity/{anchorId}", "JWT", "Retrieve existing integrity score."],
            [B("POST"), "/ai/fraud/visual", "JWT", "Visual fraud detection on credentials."],
            [B("GET"), "/ai/review", "JWT (Admin)", "List flagged items in review queue."],
            [B("PATCH"), "/ai/review/{itemId}", "JWT (Admin)", "Disposition a review queue item."],
            [B("POST"), "/ai/feedback", "JWT", "Submit extraction corrections."],
            [B("GET"), "/ai/usage", "JWT", "AI credit balance and usage history."],
            [B("POST"), "/ai/reports", "JWT", "Generate AI-powered compliance report."],
            [B("GET"), "/ai/reports/{id}", "JWT", "Retrieve a specific report."],
            [B("POST"), "/nessie/query", "JWT + x402", "RAG query against knowledge base. Cited sources."],
          ],
          [1000, 2600, 1600, 4160],
        ),

        h2("Webhook Management Endpoints"),
        spacer(60),
        makeTable(
          ["Method", "Endpoint", "Auth", "Description"],
          [
            [B("POST"), "/webhooks/test", "API key", "Send synthetic test event to verify configuration."],
            [B("GET"), "/webhooks/deliveries", "API key", "View recent delivery attempts."],
          ],
          [1000, 2600, 1600, 4160],
        ),

        h2("Key Management Endpoints"),
        spacer(60),
        makeTable(
          ["Method", "Endpoint", "Auth", "Description"],
          [
            [B("POST"), "/keys", "Supabase JWT", "Create a new API key. Raw key returned once."],
            [B("GET"), "/keys", "Supabase JWT", "List API keys (masked)."],
            [B("PATCH"), "/keys/{keyId}", "Supabase JWT", "Update key name or scopes."],
            [B("DELETE"), "/keys/{keyId}", "Supabase JWT", "Revoke an API key."],
          ],
          [1000, 2600, 1600, 4160],
        ),

        h2("Error Response Format"),
        spacer(60),
        makeTable(
          ["HTTP Status", "Meaning"],
          [
            ["400", "Invalid request parameters"],
            ["401", "Authentication required or invalid"],
            ["402", "Payment required (x402 or insufficient credits)"],
            ["403", "Insufficient permissions"],
            ["404", "Resource not found"],
            ["409", "Conflict (e.g., already revoked)"],
            ["429", "Rate limit exceeded (check Retry-After header)"],
            ["503", "Feature not enabled (feature flag is off)"],
          ],
          [2400, 6960],
        ),

        new Paragraph({ children: [new PageBreak()] }),
        // ══════════════════════════════════════════════════════════════════
        // SECTION 8: SHARED RESPONSIBILITY MATRIX
        // ══════════════════════════════════════════════════════════════════
        h1("8. Shared Responsibility Matrix"),

        h2("Partner Integration Responsibilities"),
        spacer(60),
        makeTable(
          ["Responsibility", "Arkova", "Partner"],
          [
            [B("Credential Anchoring"), "Manages Bitcoin/Base L2 transactions, fee accounts, chain confirmation.", "Submits fingerprints and metadata via API."],
            [B("Document Processing"), "Provides client-side SDKs for fingerprinting and OCR.", "Runs fingerprinting in own client or server (SHA-256)."],
            [B("Document Storage"), "Does not store documents.", "Stores and manages original documents."],
            [B("PII Management"), "Strips PII client-side before any server transmission.", "Ensures PII is not embedded in metadata sent to API."],
            [B("API Key Security"), "Issues keys, enforces HMAC hashing, scoped permissions.", "Stores keys securely. Rotates on schedule. Never client-side."],
            [B("Webhook Verification"), "Signs all outbound webhooks with HMAC-SHA256.", "Verifies X-Arkova-Signature. Rejects unsigned payloads."],
            [B("Webhook Availability"), "Retries 5x with exponential backoff. Dead letter queue.", "Maintains HTTPS endpoint. Responds < 30s. Returns 2xx."],
            [B("Rate Limits"), "Enforces limits. Returns Retry-After headers.", "Implements backoff. Caches results where appropriate."],
            [B("Data Retention"), "Configurable policies. Legal hold support.", "Defines retention requirements. Communicates legal holds."],
            [B("Credential Status"), "Real-time status: ACTIVE, REVOKED, EXPIRED, PENDING.", "Queries status before relying on credential validity."],
            [B("Attestation Claims"), "Stores, verifies, manages attestation lifecycle.", "Creates claims with accurate data. Revokes when appropriate."],
            [B("Compliance Checks"), "Provides regulatory lookups and risk scoring.", "Interprets risk scores per own compliance requirements."],
            [B("AI Accuracy"), "Targets F1 > 80% across credential types.", "Submits feedback corrections to improve accuracy."],
            [B("Uptime & SLA"), "Health monitoring, auto-scaling.", "Graceful degradation if Arkova unavailable."],
            [B("Schema Versioning"), "Frozen v1. 12-month deprecation for breaking changes.", "Builds against versioned schema. Handles additive fields."],
            [B("Jurisdiction"), "Stores and returns jurisdiction tags as metadata.", "Applies own jurisdiction-specific logic to returned data."],
          ],
          [2000, 3680, 3680],
        ),

        h2("Investor Infrastructure Summary"),
        spacer(60),
        makeTable(
          ["Dimension", "Detail"],
          [
            [B("Hosting"), "Vercel (frontend CDN), Railway (worker compute), Supabase (managed Postgres)"],
            [B("Security"), "Cloudflare Zero Trust, RLS on every table, HMAC-SHA256 API keys, cloud HSM signing, SOC 2 evidence"],
            [B("Scalability"), "Stateless worker (horizontal), Postgres pooling, CDN frontend, async batch processing"],
            [B("Reliability"), "Circuit breakers, dead letter queues, exponential backoff, idempotent webhooks"],
            [B("AI Infrastructure"), "Provider-agnostic (Gemini/OpenAI/Anthropic), credit-based costs, 2,050+ golden dataset"],
            [B("Compliance"), "GDPR (non-custodial), SOC 2 (documented), immutable audit trail, legal hold support"],
            [B("Chain Strategy"), "Bitcoin (immutability) + Base L2 (cost efficiency). Non-custodial. Technology-neutral UX."],
          ],
          [2400, 6960],
        ),

        divider(),
        spacer(120),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [
          t("This document is confidential and intended for Arkova partners, investors, and integration teams.", { size: 18, color: GRAY_TEXT, italics: true }),
        ]}),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [
          t("Generated from the Arkova Technical Directive v2026-03-23", { size: 18, color: GRAY_TEXT, italics: true }),
        ]}),
        new Paragraph({ alignment: AlignmentType.CENTER, children: [
          t("121 migrations  |  2,433+ tests  |  192 stories (94% complete)  |  24/24 audit findings resolved", { size: 18, color: GRAY_TEXT, italics: true }),
        ]}),
      ],
    },
  ],
});

// ── Generate ────────────────────────────────────────────────────────────────
const OUTPUT = "/Users/carson/Desktop/arkova-mvpcopy-main/docs/wiki/Arkova_Technical_Security_Wiki.docx";

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(OUTPUT, buffer);
  console.log(`Written: ${OUTPUT} (${(buffer.length / 1024).toFixed(0)} KB)`);
}).catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
