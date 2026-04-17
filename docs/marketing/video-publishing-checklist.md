# YouTube Explainer Video Publishing Checklist

**Jira:** [SCRUM-478 / GEO-11](https://arkova.atlassian.net/browse/SCRUM-478)
**Last updated:** 2026-04-17
**Owner:** Carson (video production + voiceover), Engineering (schema deploy)
**Engineering status:** Complete.
- Helper: [src/lib/geo/videos.ts](../../src/lib/geo/videos.ts) (canonical inventory + `buildVideoObjectsJsonLd`).
- React wrapper: [src/components/seo/VideoObjectSchema.tsx](../../src/components/seo/VideoObjectSchema.tsx).
- Tests: [src/components/seo/VideoObjectSchema.test.tsx](../../src/components/seo/VideoObjectSchema.test.tsx) (4 tests, verified green 2026-04-17).

---

## How to use this document

This is the operator's playbook for the next explainer video. Engineering plumbing is done — what remains is the video itself plus a 2-line code change per video to register it in `VIDEOS`.

Five concrete steps per video:

1. **Plan** (§Video plan) — script, screen captures, voiceover, CTA.
2. **Record + edit** — YouTube Studio, 1080p, ≤3 minutes. CC required.
3. **Publish on YouTube** — follow the §YouTube metadata checklist exactly.
4. **Register the video in the helper** — append a `VideoInventoryEntry` to `VIDEOS` in [src/lib/geo/videos.ts](../../src/lib/geo/videos.ts) and drop a `<VideoObjectSchema ... />` on the page that embeds it.
5. **Validate** with [Google Rich Results Test](https://search.google.com/test/rich-results); confirm VideoObject rich result shows; log the result in §Outcome tracker.

---

## Planned video catalog (priority order)

| # | Working title | Target length | Target page | Status |
|---|---------------|---------------|-------------|--------|
| 1 | "How Arkova verifies a credential without storing the document" | 2:30 | `/how-it-works` | Not started |
| 2 | "Proof-of-record vs promise-of-record" | 1:30 | `/` (hero below-fold embed) | Not started |
| 3 | "Kenya DPA, FERPA, HIPAA — one verification surface" | 3:00 | `/compliance` | Not started |
| 4 | "Arkova for background-check providers" | 2:00 | `/solutions/background-checks` | Not started |
| 5 | "Client-side fingerprinting, explained" | 1:45 | `/blog/client-side-fingerprinting` | Not started |

Do not emit VideoObject JSON-LD for a video that has not been uploaded and is not resolvable at its `contentUrl`. Google penalises schema that points at missing content.

---

## YouTube metadata checklist (per video)

- [ ] **Title** ≤60 chars. Pattern: `<benefit> — Arkova Verification`. Example: `Proof of record, not promise — Arkova Verification`.
- [ ] **Description** first 2 lines contain the primary keyword and the canonical `app.arkova.ai` link. Full description ≥250 words; include timestamps for chapters.
- [ ] **Chapters** defined via `0:00 Intro` / `0:30 Problem` / `1:15 Solution` lines in description (YouTube auto-generates the chapter markers).
- [ ] **Thumbnail** 1280×720 JPG/PNG, high contrast text, ≤3 words on thumbnail. Store the original at `arkova-marketing/public/video-thumbnails/<youtubeId>.jpg`.
- [ ] **Tags** (≤10): `credential verification`, `document verification`, `Bitcoin anchoring`, `privacy-preserving verification`, `background checks`, `compliance`, `FERPA`, `HIPAA`, `Kenya DPA`, `Arkova`.
- [ ] **Closed captions** — required. Use YouTube auto-captions as a base, correct manually before publish.
- [ ] **Cards + end screens** — at least one end-screen CTA linking to `app.arkova.ai`.
- [ ] **Visibility** set to Public only after the landing page's `<VideoObjectSchema />` is merged and deployed (avoid a 24-hour window where the schema references an unlisted video).

---

## Helper usage (engineering, ~10 lines per video)

1. Append the video to `VIDEOS` in [src/lib/geo/videos.ts](../../src/lib/geo/videos.ts):

   ```ts
   export const VIDEOS: VideoInventoryEntry[] = [
     {
       youtubeId: 'XXXXXXXXXXX',                      // 11-char YouTube ID
       name: 'Proof of record, not promise — Arkova Verification',
       description: 'How Arkova anchors credential fingerprints on Bitcoin without storing the original document. 90 seconds.',
       uploadDate: '2026-04-20',                       // ISO 8601
       duration: 'PT1M28S',                            // ISO 8601 duration
       thumbnailUrl: 'https://arkova.ai/video-thumbnails/XXXXXXXXXXX.jpg',
       embedPage: 'https://arkova.ai/',
     },
   ];
   ```

2. On the page that embeds the player, render the schema component:

   ```tsx
   import { VideoObjectSchema } from '@/components/seo/VideoObjectSchema';
   import { VIDEOS } from '@/lib/geo/videos';

   export function HomeHeroVideo() {
     const video = VIDEOS.find((v) => v.youtubeId === 'XXXXXXXXXXX');
     if (!video) return null;
     return (
       <>
         <VideoObjectSchema {...video} />
         <iframe src={`https://www.youtube.com/embed/${video.youtubeId}`} ... />
       </>
     );
   }
   ```

3. Add a test case in `VideoObjectSchema.test.tsx` (copy-paste existing case; assert `contentUrl` resolves, `duration` parses, and `SeekToAction.target` includes `&t={seek_to_second_number}`).

4. Deploy; wait for CDN cache to flip; then toggle the YouTube video from Unlisted → Public.

---

## Validation procedure

After deploy:

1. Open the embedding page in an incognito browser.
2. View page source; confirm one `<script type="application/ld+json">` contains `"@type":"VideoObject"` with the expected `contentUrl`.
3. Paste the page URL into [Google Rich Results Test](https://search.google.com/test/rich-results). Expected result: **Video — valid**. Warnings on `interactionStatistic` (not provided) are acceptable; errors are not.
4. Log the validation URL + result in §Outcome tracker.

---

## Outcome tracker

| Video | YouTube ID | Published | Schema deployed | Rich Result Test result | Notes |
|-------|-----------|-----------|-----------------|-------------------------|-------|
| 1. How Arkova verifies | — | — | — | — | — |
| 2. Proof vs promise | — | — | — | — | — |
| 3. Kenya DPA + FERPA + HIPAA | — | — | — | — | — |
| 4. Background-check providers | — | — | — | — | — |
| 5. Client-side fingerprinting | — | — | — | — | — |

---

## Definition of Done for SCRUM-478

- [ ] At least 1 explainer video published on YouTube channel `UCTTDFFSLxl85omCeJ9DBvrg`.
- [ ] `VIDEOS` in [src/lib/geo/videos.ts](../../src/lib/geo/videos.ts) contains ≥1 entry.
- [ ] `<VideoObjectSchema />` is rendered on the page that embeds the video, and CI shows the schema in the prerendered HTML.
- [ ] Google Rich Results Test returns "Video — valid" for that page.
- [ ] Title + description follow the §YouTube metadata checklist.
- [ ] SCRUM-478 transitioned Blocked → Done.
