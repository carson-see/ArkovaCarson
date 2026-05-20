# SCRUM-1599 Source Provenance and Sharing

Public verification pages now show safe source provenance when it is available, including the source provider, captured source URL, capture time, and evidence level. Public proof downloads include the corresponding evidence hashes and provenance fields.

LinkedIn sharing uses the Arkova verification URL as the LinkedIn Credential URL. This is not a native LinkedIn verification checkmark or LinkedIn-issued badge; LinkedIn controls how the URL appears on a member profile.

Arkova badge images are served by the worker at `/api/badge/:publicId`. Badge status is resolved from the public verification record rather than from a query parameter.
