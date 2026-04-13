/**
 * Tests for Nessie HuggingFace Upload Scripts (NMT-10 / SCRUM-673)
 *
 * Verifies model card content, repo configuration, and upload script logic
 * for both the v5 extraction model and intelligence model uploads.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read shell script content for validation
const UPLOAD_SCRIPT_PATH = resolve(import.meta.dirname ?? '.', 'upload-hf-v5.sh');
const uploadScript = readFileSync(UPLOAD_SCRIPT_PATH, 'utf-8');

describe('nessie-hf-upload (NMT-10)', () => {
  describe('v5 upload script (upload-hf-v5.sh)', () => {
    it('should target correct Together AI model', () => {
      expect(uploadScript).toContain(
        'carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-v5-87e1d401',
      );
    });

    it('should target correct HuggingFace repo', () => {
      expect(uploadScript).toContain('carsonarkova/nessie-v5-llama-3.1-8b');
    });

    it('should require TOGETHER_API_KEY', () => {
      expect(uploadScript).toContain('TOGETHER_API_KEY');
    });

    it('should require HF_TOKEN', () => {
      expect(uploadScript).toContain('HF_TOKEN');
    });

    it('should use strict bash mode', () => {
      expect(uploadScript).toContain('set -euo pipefail');
    });

    it('should include model card with eval results', () => {
      expect(uploadScript).toContain('Weighted F1');
      expect(uploadScript).toContain('87.2');
    });

    it('should include model card with training details', () => {
      expect(uploadScript).toContain('ft-b8594db6-80f9');
      expect(uploadScript).toContain('1,903 train');
    });

    it('should support --no-cleanup flag', () => {
      expect(uploadScript).toContain('--no-cleanup');
    });

    it('should handle non-interactive mode for CI', () => {
      expect(uploadScript).toContain('Non-interactive');
    });

    it('should include llama3.1 license in model card', () => {
      expect(uploadScript).toContain('license: llama3.1');
    });
  });

  describe('model card content validation', () => {
    it('should include HuggingFace frontmatter', () => {
      // Model card embedded in shell script between MODELCARD heredoc
      const modelCardMatch = uploadScript.match(/cat > .*README\.md.*<<\s*'MODELCARD'([\s\S]*?)MODELCARD/);
      expect(modelCardMatch).not.toBeNull();
      const modelCard = modelCardMatch![1];

      expect(modelCard).toContain('license:');
      expect(modelCard).toContain('base_model:');
      expect(modelCard).toContain('tags:');
    });

    it('should list supported credential types', () => {
      expect(uploadScript).toContain('DEGREE');
      expect(uploadScript).toContain('LICENSE');
      expect(uploadScript).toContain('CERTIFICATE');
      expect(uploadScript).toContain('SEC_FILING');
    });

    it('should include domain adapter details', () => {
      expect(uploadScript).toContain('SEC');
      expect(uploadScript).toContain('Academic');
      expect(uploadScript).toContain('Legal');
      expect(uploadScript).toContain('Regulatory');
    });

    it('should document known limitations', () => {
      expect(uploadScript).toContain('Limitations');
      expect(uploadScript).toContain('PII-stripped');
    });

    it('should include citation info', () => {
      expect(uploadScript).toContain('Citation');
      expect(uploadScript).toContain('Arkova');
    });
  });

  describe('intelligence model upload (nessie-hf-upload.ts)', () => {
    // Read the TS upload script
    const tsUploadPath = resolve(import.meta.dirname ?? '.', 'nessie-hf-upload.ts');
    const tsUpload = readFileSync(tsUploadPath, 'utf-8');

    it('should target intelligence model repo', () => {
      expect(tsUpload).toContain('nessie-intelligence-v1-llama-3.1-8b');
    });

    it('should include intelligence model card', () => {
      expect(tsUpload).toContain('Nessie Intelligence v1');
      expect(tsUpload).toContain('Compliance Reasoning Model');
    });

    it('should describe all 5 intelligence modes', () => {
      expect(tsUpload).toContain('compliance_qa');
      expect(tsUpload).toContain('risk_analysis');
      expect(tsUpload).toContain('document_summary');
      expect(tsUpload).toContain('recommendation');
      expect(tsUpload).toContain('cross_reference');
    });

    it('should document domain coverage', () => {
      expect(tsUpload).toContain('SEC & Financial');
      expect(tsUpload).toContain('Legal & Case Law');
      expect(tsUpload).toContain('Regulatory');
      expect(tsUpload).toContain('Patent & IP');
      expect(tsUpload).toContain('Academic');
    });

    it('should include LoRA training details', () => {
      expect(tsUpload).toContain('LoRA');
      expect(tsUpload).toContain('rank 32');
      expect(tsUpload).toContain('alpha 64');
    });

    it('should support --dry-run flag', () => {
      expect(tsUpload).toContain('--dry-run');
    });

    it('should include HuggingFace API calls', () => {
      expect(tsUpload).toContain('huggingface.co/api');
    });
  });
});
