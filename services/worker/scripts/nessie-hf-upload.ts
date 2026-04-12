/**
 * Nessie Intelligence Model — HuggingFace Upload Script (NCE-20)
 *
 * Uploads Nessie Intelligence v1 model weights + model card to HuggingFace.
 * Extends NMT-05 with intelligence-specific model card.
 *
 * Usage:
 *   npx tsx scripts/nessie-hf-upload.ts --repo carsonarkova/nessie-intelligence-v1-llama-3.1-8b [--dry-run]
 *
 * Prerequisites:
 *   - HF_TOKEN env var set with write access
 *   - Model weights available locally or on RunPod
 *
 * Jira: SCRUM-611
 */

const MODEL_CARD = `---
license: llama3.1
base_model: meta-llama/Meta-Llama-3.1-8B-Instruct
tags:
  - compliance
  - legal
  - regulatory
  - nessie
  - arkova
  - lora
  - fine-tuned
datasets:
  - custom
language:
  - en
pipeline_tag: text-generation
---

# Nessie Intelligence v1 — Compliance Reasoning Model

**Nessie Intelligence** is a fine-tuned Llama 3.1 8B model specialized for compliance intelligence tasks: jurisdiction-aware Q&A, risk analysis, document summarization, actionable recommendations, and cross-reference analysis.

## Model Details

| Property | Value |
|----------|-------|
| Base Model | Meta Llama 3.1 8B Instruct |
| Fine-tuning Method | LoRA (rank 32, alpha 64) |
| Training Platform | Together AI |
| Training Data | 1,150+ compliance Q&A pairs across 5 domains |
| Precision | bf16 |
| Deployment | vLLM on RunPod (A6000 48GB) |

## Capabilities

### 5 Intelligence Modes

1. **compliance_qa** — Answer compliance questions with cited sources
2. **risk_analysis** — Identify risks, red flags, jurisdiction conflicts
3. **document_summary** — Synthesize findings across documents
4. **recommendation** — Actionable steps to improve compliance posture
5. **cross_reference** — Compare documents for consistency

### Domain Coverage

- SEC & Financial Compliance (10-K, 10-Q, 8-K analysis)
- Legal & Case Law (court opinions, regulatory actions)
- Regulatory (Federal Register, state regulations)
- Patent & IP (USPTO patent analysis)
- Academic (research publications, accreditation)

## Evaluation Results

| Metric | Target | Achieved |
|--------|--------|----------|
| Citation Accuracy | >95% | See eval/ |
| Faithfulness | >0.90 | See eval/ |
| Answer Relevance | >0.85 | See eval/ |
| Risk Detection Recall | >80% | See eval/ |
| Latency P95 | <5s | See eval/ |

## Usage

\`\`\`python
from vllm import LLM, SamplingParams

model = LLM("carsonarkova/nessie-intelligence-v1-llama-3.1-8b")
params = SamplingParams(temperature=0.1, max_tokens=2048)

prompt = """<|begin_of_text|><|start_header_id|>system<|end_header_id|>
You are Nessie, Arkova's compliance intelligence assistant...
<|eot_id|><|start_header_id|>user<|end_header_id|>
What continuing education requirements apply to California CPAs?
<|eot_id|><|start_header_id|>assistant<|end_header_id|>"""

output = model.generate([prompt], params)
print(output[0].outputs[0].text)
\`\`\`

## Training Data Composition

| Domain | Examples | Task Types |
|--------|----------|-----------|
| SEC / Financial | 250 | compliance_qa, risk_analysis, document_summary |
| Legal / Court | 200 | compliance_qa, cross_reference, recommendation |
| Regulatory | 200 | compliance_qa, recommendation, document_summary |
| Patent / IP | 150 | cross_reference, risk_analysis, document_summary |
| Academic | 100 | risk_analysis, cross_reference, document_summary |
| General (forgetting prevention) | 250 | All types |

## Limitations

- Trained primarily on US regulatory data; international coverage is limited
- Citation accuracy depends on retrieval quality (RAG recommended)
- Not a substitute for legal advice — always verify with qualified professionals
- 8B parameter model has inherent limitations on complex multi-step reasoning

## Citation

If you use this model, please cite:

\`\`\`
@misc{arkova-nessie-intelligence-2026,
  title={Nessie Intelligence: A Compliance Reasoning Model},
  author={Arkova},
  year={2026},
  publisher={HuggingFace},
  url={https://huggingface.co/carsonarkova/nessie-intelligence-v1-llama-3.1-8b}
}
\`\`\`

## License

This model is released under the Llama 3.1 Community License.
`;

async function main() {
  const args = process.argv.slice(2);
  const repoIdx = args.indexOf('--repo');
  const repo = repoIdx >= 0 ? args[repoIdx + 1] : 'carsonarkova/nessie-intelligence-v1-llama-3.1-8b';
  const dryRun = args.includes('--dry-run');

  const hfToken = process.env.HF_TOKEN;
  if (!hfToken && !dryRun) {
    console.error('ERROR: HF_TOKEN environment variable not set');
    process.exit(1);
  }

  console.log(`Nessie Intelligence v1 — HuggingFace Upload`);
  console.log(`Repository: ${repo}`);
  console.log(`Model card: ${MODEL_CARD.split('\n').length} lines`);

  if (dryRun) {
    console.log(`\n[DRY RUN] Would upload to https://huggingface.co/${repo}`);
    console.log(`[DRY RUN] Model card preview:\n`);
    console.log(MODEL_CARD.substring(0, 500) + '...');
    return;
  }

  // Step 1: Create/update repo
  console.log(`\nCreating repository ${repo}...`);
  const createRes = await fetch(`https://huggingface.co/api/repos/create`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${hfToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: repo.split('/')[1],
      organization: repo.split('/')[0],
      type: 'model',
      private: false,
    }),
  });

  if (createRes.ok || createRes.status === 409) {
    console.log(`Repository ready (${createRes.status === 409 ? 'already exists' : 'created'})`);
  } else {
    console.warn(`Repository creation returned ${createRes.status} — continuing anyway`);
  }

  // Step 2: Upload model card
  console.log(`Uploading README.md (model card)...`);
  const uploadRes = await fetch(`https://huggingface.co/api/${repo}/upload/main/README.md`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${hfToken}`,
      'Content-Type': 'text/plain',
    },
    body: MODEL_CARD,
  });

  if (uploadRes.ok) {
    console.log(`Model card uploaded successfully`);
  } else {
    console.error(`Model card upload failed: ${uploadRes.status}`);
  }

  console.log(`\nDone. Model weights must be uploaded separately via:`);
  console.log(`  huggingface-cli upload ${repo} /path/to/merged-model/`);
  console.log(`\nVerify at: https://huggingface.co/${repo}`);
}

main().catch(console.error);
