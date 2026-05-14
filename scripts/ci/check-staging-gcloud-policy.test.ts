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

  it('keeps following long shell continuations until the staging target appears', () => {
    const hits = scanTextForRawStagingGcloud(
      '.github/workflows/staging.yml',
      [
        'run: |',
        '  gcloud run services update \\',
        '    --region us-central1 \\',
        '    --project arkova1 \\',
        '    --update-env-vars A=1 \\',
        '    --update-env-vars B=2 \\',
        '    --update-env-vars C=3 \\',
        '    arkova-worker-staging',
      ].join('\n'),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain('arkova-worker-staging');
  });

  it('flags raw staging deploys when gcloud command tokens are split across continuations', () => {
    const hits = scanTextForRawStagingGcloud(
      '.github/workflows/staging.yml',
      [
        'run: |',
        '  gcloud \\',
        '    run deploy \\',
        '    --region us-central1 \\',
        '    --project arkova1 \\',
        '    arkova-worker-staging',
      ].join('\n'),
    );

    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain('arkova-worker-staging');
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

  it('does not allow exception markers in executable shell files', () => {
    const hits = scanTextForRawStagingGcloud(
      'scripts/staging/bypass.sh',
      [
        '# staging-gcloud-ok: shell scripts must use scripts/staging/deploy.sh',
        'gcloud run deploy arkova-worker-staging --image old',
      ].join('\n'),
    );

    expect(hits).toHaveLength(1);
  });

  it('does not allow exception markers in shell files under docs', () => {
    const hits = scanTextForRawStagingGcloud(
      'docs/staging/bypass.sh',
      [
        '# staging-gcloud-ok: only prose transcripts may use this marker',
        'gcloud run deploy arkova-worker-staging --image old',
      ].join('\n'),
    );

    expect(hits).toHaveLength(1);
  });

  it('does not apply long-prefix docs heuristics to workflow files', () => {
    const hits = scanTextForRawStagingGcloud(
      '.github/workflows/staging.yml',
      '      - name: intentionally long workflow prefix before raw gcloud command: gcloud run deploy arkova-worker-staging --image old',
    );

    expect(hits).toHaveLength(1);
  });
});
