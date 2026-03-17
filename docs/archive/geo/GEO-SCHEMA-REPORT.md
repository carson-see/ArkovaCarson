# Schema & Structured Data Report — arkova.ai

**Date:** 2026-03-15
**URL:** https://arkova.ai
**Schema Score: 52/100**

---

## Existing Schemas (3 found)

| # | Type | Format | Valid | Rich Result | Issues |
|---|------|--------|:-----:|:-----------:|--------|
| 1 | Organization | JSON-LD | Yes | Knowledge Panel | sameAs incomplete (2 platforms, one wrong), no founder, no address |
| 2 | SoftwareApplication | JSON-LD | Yes | Partial | Missing aggregateRating, screenshot, AggregateOffer |
| 3 | FAQPage | JSON-LD | Yes | Restricted* | Structurally correct, 6 Q&As. *Restricted since Aug 2023 but valuable for AI |

## Missing Schemas (5 needed)

| Schema | GEO Impact | Purpose |
|--------|-----------|---------|
| **Person** (founder) | Critical | E-E-A-T expertise signal — AI models need to know who's behind the product |
| **WebSite** + SearchAction | High | Sitelinks search box eligibility, entity recognition |
| **speakable** | Medium | AI assistant readiness — marks content suitable for voice/spoken responses |
| **BreadcrumbList** | Low | Navigation context for subpages (add when pages exist) |
| **VideoObject** | Low | YouTube/video schema (add when video content exists) |

---

## Critical Fix: LinkedIn sameAs

The Organization schema's `sameAs` currently links to **"Arkova Partners"** (a financial services firm) — not Arkova. This entity collision actively harms AI recognition on every platform.

**Action:** Create the correct LinkedIn company page for Arkova and update the sameAs URL.

---

## Generated JSON-LD — Ready to Deploy

### 1. Enhanced Organization (replace existing)

```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Arkova",
  "legalName": "Arkova",
  "url": "https://arkova.ai",
  "logo": {
    "@type": "ImageObject",
    "url": "https://arkova.ai/arkova-logo.png",
    "width": 512,
    "height": 512
  },
  "description": "Privacy-first document verification platform. Create tamper-proof records using cryptographic fingerprinting — documents never leave your device.",
  "foundingDate": "2025-01-01",
  "founder": [
    {
      "@type": "Person",
      "name": "[FOUNDER NAME]",
      "jobTitle": "[TITLE, e.g. CEO & Co-Founder]",
      "sameAs": ["[LINKEDIN URL]", "[TWITTER URL]"]
    }
  ],
  "sameAs": [
    "[CORRECT LINKEDIN COMPANY URL]",
    "https://x.com/arkaboratory",
    "[GITHUB ORG URL]",
    "[CRUNCHBASE URL]",
    "[YOUTUBE URL]"
  ],
  "contactPoint": [
    {
      "@type": "ContactPoint",
      "email": "hello@arkova.ai",
      "contactType": "sales",
      "availableLanguage": "English"
    }
  ],
  "address": {
    "@type": "PostalAddress",
    "addressLocality": "[CITY]",
    "addressRegion": "[STATE]",
    "addressCountry": "US"
  },
  "areaServed": "Worldwide",
  "knowsAbout": [
    "Document verification",
    "Cryptographic fingerprinting",
    "Credential management",
    "Digital trust infrastructure"
  ],
  "slogan": "Verify Once. Trust Forever."
}
```

### 2. WebSite + SearchAction (new — add to head)

```json
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "Arkova",
  "alternateName": "Arkova",
  "url": "https://arkova.ai",
  "description": "Privacy-first document verification platform using cryptographic fingerprinting.",
  "publisher": {
    "@type": "Organization",
    "name": "Arkova",
    "url": "https://arkova.ai"
  }
}
```

### 3. Person — Founder (new — add to head)

```json
{
  "@context": "https://schema.org",
  "@type": "Person",
  "name": "[FOUNDER NAME]",
  "url": "[PROFILE URL on arkova.ai]",
  "image": "[HEADSHOT URL]",
  "jobTitle": "[TITLE]",
  "worksFor": {
    "@type": "Organization",
    "name": "Arkova",
    "url": "https://arkova.ai"
  },
  "description": "[1-2 sentence bio highlighting relevant expertise]",
  "knowsAbout": [
    "Document verification",
    "Cryptographic systems",
    "Privacy-preserving technology"
  ],
  "sameAs": [
    "[LINKEDIN PERSONAL URL]",
    "[TWITTER PERSONAL URL]",
    "[GITHUB PERSONAL URL]"
  ],
  "alumniOf": {
    "@type": "EducationalOrganization",
    "name": "[UNIVERSITY]"
  }
}
```

### 4. Enhanced SoftwareApplication (replace existing)

```json
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Arkova",
  "applicationCategory": "BusinessApplication",
  "applicationSubCategory": "Document Verification",
  "operatingSystem": "Web",
  "description": "Privacy-first document verification platform. Create tamper-proof records using cryptographic fingerprinting — documents never leave your device.",
  "url": "https://arkova.ai",
  "offers": {
    "@type": "AggregateOffer",
    "lowPrice": "0",
    "highPrice": "[HIGHEST TIER PRICE]",
    "priceCurrency": "USD",
    "offerCount": "3",
    "offers": [
      {
        "@type": "Offer",
        "name": "Free",
        "price": "0",
        "priceCurrency": "USD",
        "description": "50 anchors per month"
      },
      {
        "@type": "Offer",
        "name": "Professional",
        "price": "[PRICE]",
        "priceCurrency": "USD",
        "description": "500 anchors per month, priority support"
      }
    ]
  },
  "featureList": [
    "Client-side SHA-256 cryptographic fingerprinting",
    "Public verification via shareable links and QR codes",
    "AI-powered metadata extraction and classification",
    "Verification API with batch processing",
    "PDF proof certificates with audit trails",
    "Bulk CSV credential anchoring",
    "Organization management and credential templates",
    "Webhook notifications"
  ],
  "screenshot": [
    {
      "@type": "ImageObject",
      "url": "[DASHBOARD SCREENSHOT URL]",
      "caption": "Arkova dashboard showing anchored credentials"
    }
  ],
  "creator": {
    "@type": "Organization",
    "name": "Arkova",
    "url": "https://arkova.ai"
  },
  "datePublished": "2025-01-01"
}
```

### 5. Speakable WebPage (new — add to head)

```json
{
  "@context": "https://schema.org",
  "@type": "WebPage",
  "name": "Arkova — Verify Once. Trust Forever.",
  "url": "https://arkova.ai",
  "description": "Privacy-first document verification using cryptographic fingerprinting.",
  "speakable": {
    "@type": "SpeakableSpecification",
    "cssSelector": [
      ".hero-headline",
      ".hero-subheadline",
      ".value-proposition"
    ]
  },
  "mainEntity": {
    "@type": "SoftwareApplication",
    "name": "Arkova"
  }
}
```

---

## Score Breakdown

| Component | Points | Earned | Notes |
|-----------|--------|--------|-------|
| Organization present | 20 | 10 | sameAs has only 2 platforms (one wrong) |
| Person schema | 15 | 0 | Missing — no founder/team |
| sameAs completeness | 15 | 3 | 2 platforms, need 5+ |
| speakable property | 10 | 0 | Missing |
| WebSite schema | 5 | 0 | Missing |
| BreadcrumbList | 5 | 0 | Missing (acceptable for single page) |
| No deprecated schemas | 5 | 5 | Clean |
| JSON-LD format | 5 | 5 | All schemas use JSON-LD |
| Validation (no errors) | 5 | 5 | All pass syntax validation |
| SoftwareApplication | — | 12 | Present with features, offers |
| FAQPage | — | 10 | Valid, 6 Q&A pairs |
| **Total** | **100** | **52** | |

---

## Implementation Priority

1. **[CRITICAL]** Fix LinkedIn sameAs + expand to 5+ platforms
2. **[HIGH]** Add Person schema for founder(s)
3. **[HIGH]** Replace SoftwareApplication with AggregateOffer version
4. **[HIGH]** Add WebSite schema
5. **[MEDIUM]** Add speakable WebPage schema
6. **[MEDIUM]** Improve foundingDate to full ISO 8601
7. **[LOW]** Add BreadcrumbList when subpages exist

All `[REPLACE]` placeholders in the JSON-LD above need to be filled with actual values before deploying.
