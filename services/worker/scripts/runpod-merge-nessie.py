#!/usr/bin/env python3
"""
runpod-merge-nessie.py — RUNS INSIDE a RunPod GPU pod.

Canonical Nessie adapter → merged-model-on-HF pipeline, proven end-to-end on
v26 and re-used for v27/v28/v29+.

Flow:
  1. Download LoRA adapter from Together via SDK
     client.fine_tuning.content(ft_id=..., checkpoint='adapter')
     (the `together fine-tuning download` CLI is BROKEN for completed jobs).
     The BinaryAPIResponse streams bytes — write to disk.
  2. If the blob is zstd-compressed, decompress. Extract tar.
  3. Strip adapter_config.json keys that PEFT 0.15 doesn't know about:
       corda_config, eva_config, arrow_config, qalora_config, lora_bias,
       trainable_token_indices, exclude_modules, use_dora, layer_replication
  4. Override base_model_name_or_path -> meta-llama/Meta-Llama-3.1-8B-Instruct
     (Together names it `-Reference` which is not a public HF model).
  5. Load base + adapter with PeftModel.from_pretrained(
        ..., autocast_adapter_dtype=False
     ) — autocast=False avoids the torch float8_e8m0fnu code path that
     crashes on 2.4.x.
  6. merge_and_unload() → save_pretrained() → HF upload.

Required env:
  TOGETHER_API_KEY, TOGETHER_JOB_ID, HF_TOKEN, HF_TARGET_REPO
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

WORKDIR = Path('/workspace')
ADAPTER_DIR = WORKDIR / 'adapter'
MERGED_DIR = WORKDIR / 'merged'
DOWNLOAD_DIR = WORKDIR / 'download'

STRIP_KEYS = {
    'corda_config', 'eva_config', 'arrow_config', 'qalora_config', 'lora_bias',
    'trainable_token_indices', 'exclude_modules', 'use_dora', 'layer_replication',
}

BASE_MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct'


def log(msg: str) -> None:
    print(f'[merge] {msg}', flush=True)


def require_env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        log(f'FATAL: ${name} not set')
        sys.exit(2)
    return v


def pip_install() -> None:
    log('Installing Python deps (peft==0.15.0, transformers>=4.46,<5)...')
    subprocess.check_call([
        sys.executable, '-m', 'pip', 'install', '--quiet',
        'together>=1.3.0', 'huggingface_hub>=0.24.0',
        'peft==0.15.0', 'transformers>=4.46.0,<5',
        'accelerate>=0.34.0', 'safetensors>=0.4.0', 'zstandard',
    ])


def download_adapter(job_id: str, api_key: str) -> Path:
    """
    Together's .content() returns a BinaryAPIResponse. We stream it to disk
    as adapter.bin, then sniff the magic bytes to detect zstd vs tar vs zip.
    """
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    blob_path = DOWNLOAD_DIR / f'{job_id}.bin'

    log(f'Downloading adapter for {job_id} via SDK .content(checkpoint="adapter")...')
    from together import Together
    client = Together(api_key=api_key)
    resp = client.fine_tuning.content(ft_id=job_id, checkpoint='adapter')
    # BinaryAPIResponse exposes .iter_bytes() and .read()
    with open(blob_path, 'wb') as f:
        if hasattr(resp, 'iter_bytes'):
            for chunk in resp.iter_bytes(chunk_size=1024 * 1024):
                f.write(chunk)
        elif hasattr(resp, 'read'):
            f.write(resp.read())
        else:
            # Legacy fallback — .content attribute
            f.write(resp.content)
    size_mb = blob_path.stat().st_size / 1e6
    log(f'Downloaded {size_mb:.1f} MB to {blob_path}')
    if size_mb < 1:
        log(f'FATAL: adapter blob suspiciously small ({size_mb:.3f} MB)')
        sys.exit(3)

    # Sniff magic bytes to decide format
    with open(blob_path, 'rb') as f:
        head = f.read(8)
    log(f'Blob magic bytes: {head.hex()}')

    ADAPTER_DIR.mkdir(parents=True, exist_ok=True)

    if head[:4] == b'\x28\xb5\x2f\xfd':
        # zstd magic
        import zstandard as zstd
        tar_path = DOWNLOAD_DIR / 'adapter.tar'
        log('Detected zstd. Decompressing...')
        with open(blob_path, 'rb') as fin, open(tar_path, 'wb') as fout:
            dctx = zstd.ZstdDecompressor()
            dctx.copy_stream(fin, fout)
        log(f'Decompressed to {tar_path} ({tar_path.stat().st_size / 1e6:.1f} MB)')
        with tarfile.open(tar_path) as tf:
            tf.extractall(str(ADAPTER_DIR))
    elif head[:2] == b'PK':
        # zip magic
        log('Detected zip.')
        with zipfile.ZipFile(blob_path) as zf:
            zf.extractall(str(ADAPTER_DIR))
    elif head[257:262] == b'ustar' or head[:2] == b'\x1f\x8b':
        # tar or gzip-tar
        log('Detected tar/gzip-tar.')
        with tarfile.open(blob_path) as tf:
            tf.extractall(str(ADAPTER_DIR))
    else:
        # Try tar anyway (some blobs have no magic)
        log('Unknown magic. Trying tar...')
        try:
            with tarfile.open(blob_path) as tf:
                tf.extractall(str(ADAPTER_DIR))
        except Exception as e:
            log(f'FATAL: cannot extract adapter blob: {e}')
            sys.exit(4)

    # Flatten nested dir if archive contains a single top-level dir
    entries = list(ADAPTER_DIR.iterdir())
    if len(entries) == 1 and entries[0].is_dir():
        inner = entries[0]
        log(f'Flattening nested dir {inner.name}...')
        for p in list(inner.iterdir()):
            shutil.move(str(p), str(ADAPTER_DIR / p.name))
        inner.rmdir()

    log(f'Adapter extracted to {ADAPTER_DIR}:')
    for p in sorted(ADAPTER_DIR.iterdir()):
        log(f'  {p.name} ({p.stat().st_size / 1e6:.2f} MB)')

    return ADAPTER_DIR


def sanitize_adapter_config(adapter_dir: Path) -> None:
    cfg_path = adapter_dir / 'adapter_config.json'
    if not cfg_path.exists():
        log(f'FATAL: {cfg_path} missing')
        sys.exit(5)
    with open(cfg_path) as f:
        cfg = json.load(f)
    removed = []
    for k in list(cfg.keys()):
        if k in STRIP_KEYS:
            del cfg[k]
            removed.append(k)
    old_base = cfg.get('base_model_name_or_path')
    cfg['base_model_name_or_path'] = BASE_MODEL
    with open(cfg_path, 'w') as f:
        json.dump(cfg, f, indent=2)
    log(f'adapter_config.json: stripped {removed}')
    log(f'  base_model_name_or_path: {old_base} -> {BASE_MODEL}')


def merge_and_push(adapter_dir: Path, hf_repo: str, hf_token: str) -> None:
    log(f'Loading base {BASE_MODEL} in bfloat16 on GPU...')
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    base = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL, torch_dtype=torch.bfloat16, device_map='auto', token=hf_token,
    )
    tok = AutoTokenizer.from_pretrained(BASE_MODEL, token=hf_token)

    log('Loading adapter with autocast_adapter_dtype=False (bypasses float8_e8m0fnu)...')
    peft_model = PeftModel.from_pretrained(
        base, str(adapter_dir), autocast_adapter_dtype=False,
    )

    log('Calling merge_and_unload()...')
    merged = peft_model.merge_and_unload()

    MERGED_DIR.mkdir(parents=True, exist_ok=True)
    log(f'Saving merged to {MERGED_DIR} (safe_serialization, 5GB shards)...')
    merged.save_pretrained(str(MERGED_DIR), safe_serialization=True, max_shard_size='5GB')
    tok.save_pretrained(str(MERGED_DIR))

    log(f'Files ready in {MERGED_DIR}:')
    for p in sorted(MERGED_DIR.iterdir()):
        log(f'  {p.name} ({p.stat().st_size / 1e6:.2f} MB)')

    log(f'Pushing to HF: {hf_repo}')
    from huggingface_hub import HfApi, login
    login(token=hf_token)
    api = HfApi()
    api.create_repo(repo_id=hf_repo, exist_ok=True, private=False, token=hf_token)
    api.upload_folder(
        folder_path=str(MERGED_DIR),
        repo_id=hf_repo,
        commit_message='Auto-merged Nessie adapter (peft 0.15, autocast=False)',
        token=hf_token,
    )
    log(f'HF push complete: https://huggingface.co/{hf_repo}')


def main() -> int:
    job_id = require_env('TOGETHER_JOB_ID')
    api_key = require_env('TOGETHER_API_KEY')
    hf_token = require_env('HF_TOKEN')
    hf_repo = require_env('HF_TARGET_REPO')

    WORKDIR.mkdir(exist_ok=True)
    pip_install()
    adapter_dir = download_adapter(job_id, api_key)
    sanitize_adapter_config(adapter_dir)
    merge_and_push(adapter_dir, hf_repo, hf_token)

    (WORKDIR / 'DONE').write_text(f'merged:{hf_repo}\n')
    log('ALL STEPS COMPLETE.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
