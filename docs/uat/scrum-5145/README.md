# SCRUM-5145 browser evidence

Captured by `e2e/uat17-email-confirmation.spec.ts` on 2026-09-14 and visually reviewed after the six-case Playwright run passed. The fixture mounts the production signup, confirmation, and callback components while simulating Auth HTTP responses. These images prove layout and truthful state rendering; hosted SMTP, Auth expiry, trigger, membership, and MFA evidence remains a separate release gate.

| Artifact | View | SHA-256 |
| --- | --- | --- |
| `resend-success-375.png` | Successful resend, 375 px | `170f78db9b1160f6e02e8cbcee2ddcf3f944f066c28fc88a9b5035247bba7bb0` |
| `resend-error-1280.png` | Failed resend, 1280 px | `9a2dddde10174e1095a1acc96c01227a3d8573079d86563c02d69cd4ca3fd82e` |
| `expired-link-375.png` | Actionable expired link, 375 px | `b1eaffa83c9b866054267917e4dbd6b2910b5f32af5eed2dc70021836b607495` |
