import { describe, expect, it } from 'vitest';

import { scanTextForRawStagingGcloud } from './check-staging-gcloud-policy.js';

describe('check-staging-gcloud-policy', () => {
  it('flags raw staging gcloud deploy commands outside deploy.sh', () => {
    const hits = scanTextForRawStagingGcloud(
      'docs/staging/README.md',
      'gcloud run deploy arkova-worker-staging --image us-central1-docker.pkg.dev/arkova1/img:tag',
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file: 'docs/staging/README.md', line: 1 });
  });

  it('flags multiline raw staging service updates', () => {
    const hits = scanTextForRawStagingGcloud(
      '.github/workflows/staging.yml',
      [
        'run: |',
        '  gcloud run services update \\',
        '    arkova-worker-staging \\',
        '    --region us-central1',
      ].join('\n'),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain('gcloud run services update');
  });

  it('allows the lease-enforced deploy wrapper itself', () => {
    const hits = scanTextForRawStagingGcloud(
      'scripts/staging/deploy.sh',
      'gcloud run services update "$SERVICE" "${GCLOUD_FLAGS[@]}"',
    );

    expect(hits).toEqual([]);
  });

  it('does not flag production worker deploys', () => {
    const hits = scanTextForRawStagingGcloud(
      'scripts/deploy-worker.sh',
      'gcloud run deploy arkova-worker --source=services/worker/',
    );

    expect(hits).toEqual([]);
  });

  it('allows explicit exceptions with a nearby reason', () => {
    const hits = scanTextForRawStagingGcloud(
      'docs/staging/historical.md',
      [
        '# staging-gcloud-ok: historical incident transcript, do not run',
        'gcloud run deploy arkova-worker-staging --image old',
      ].join('\n'),
    );

    expect(hits).toEqual([]);
  });
});
