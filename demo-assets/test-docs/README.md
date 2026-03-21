# Test Documents for Demo

These documents are for testing the Arkova credential anchoring flow.

## Files

| File | Type | Use Case |
|------|------|----------|
| `bulk-credentials.csv` | CSV | Bulk upload — 6 UMich credentials with metadata |
| `university-transcript.txt` | Text | Single upload → AI extraction (academic) |
| `medical-license.txt` | Text | Single upload → AI extraction (license) |
| `professional-certificate.txt` | Text | Single upload → AI extraction (certificate) |
| `teaching-license.txt` | Text | Single upload → AI extraction (license) |

## Demo Flow

1. **Single upload**: Upload any .txt file → Secure Document → AI extracts metadata → Anchor
2. **Bulk upload**: Upload `bulk-credentials.csv` → Map columns → AI Extract → Process
3. **Verify**: After anchoring, visit the verification page to see the rendered credential
