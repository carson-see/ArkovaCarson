# App and credential rehearsal evidence

## App boundary

The generic tag/date work includes an authenticated application query path using the same private-record corpus rules as the API: organization-bound records, non-deleted rows, non-null public IDs, and exclusion of pipeline ingestion rows. Source/unit qualification exists in the combined candidate evidence, but a real browser session and deployed backend were not exercised here. App availability and live acceptance remain open.

## Credential rehearsal

Five synthetic variants were prepared and checked locally: academic credential, technical credential/badge, two-hour CLE, 1.5-hour CPE, and professional license. The local harness reported 70 CTDL mapping assertions passing. The rehearsal used synthetic files and mocked verification responses; it did not establish a real proof, license standing, issuer permission, production Credential Engine publish/update, or customer acceptance.

The operator flow remains: issue a synthetic record, observe the real Arkova state vocabulary (PENDING then SECURED when anchoring succeeds), open public verification, recheck the file/QR/proof, and test an altered-file negative. Hosted steps are still unexecuted.
