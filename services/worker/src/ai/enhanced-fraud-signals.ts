/**
 * GME-13: Enhanced Fraud Detection Signals
 *
 * New fraud signal categories leveraging Gemini 3's improved
 * multimodal reasoning capabilities. These augment the original
 * categories (font, layout, manipulation, metadata, security_feature)
 * with three new detection types.
 */

/** All fraud signal categories (original + Gemini 3 enhanced) */
export const ENHANCED_FRAUD_CATEGORIES = [
  // Original categories (Phase 5)
  'font',
  'layout',
  'manipulation',
  'metadata',
  'security_feature',
  // GME-13: New Gemini 3 Vision categories
  'watermark',           // watermark manipulation, removal, or overlay artifacts
  'resolution',          // resolution inconsistency between document regions
  'metadata_stripping',  // evidence of metadata removal (EXIF, XMP stripping)
] as const;

export type FraudSignalCategory = typeof ENHANCED_FRAUD_CATEGORIES[number];

/** Check if a string is a valid fraud signal category */
export function isEnhancedSignalCategory(category: string): category is FraudSignalCategory {
  return (ENHANCED_FRAUD_CATEGORIES as readonly string[]).includes(category);
}

/**
 * Additional prompt section for Gemini 3 Vision enhanced signals.
 * Appended to the existing VISUAL_FRAUD_SYSTEM_PROMPT.
 */
export const ENHANCED_FRAUD_PROMPT_SECTION = `
8. **Watermark Analysis** (Gemini 3 Enhanced):
   - Check for watermark removal artifacts (ghost patterns, color banding)
   - Look for watermark overlay inconsistencies (misaligned, wrong opacity)
   - Verify expected institutional watermarks are present and authentic
   - Check for "COPY" or "VOID" watermark tampering

9. **Resolution Consistency** (Gemini 3 Enhanced):
   - Compare DPI/resolution across different regions of the document
   - Flag regions where resolution differs significantly (suggests compositing)
   - Check text rendering sharpness consistency
   - Look for upscaling artifacts around specific text or signature blocks

10. **Metadata Stripping** (Gemini 3 Enhanced):
    - Note if the image lacks expected EXIF/XMP metadata for the claimed format
    - Check for re-encoding indicators (double JPEG compression artifacts)
    - Flag if creation tool metadata is inconsistent with document type
    - Look for screenshot-of-a-document patterns (screen recording artifacts)
`;
