#!/usr/bin/env python3
"""Probe every (matte_type, color) combination against the live TV and record
which ones the TV rejects with error -7.

Designed to run **inside the container** so it reuses the existing
/data/token_file.txt and writes to /data/matte_blocklist.json (which serve.py
exposes at /api/matte_blocklist for the web UI to consume).

Typical usage (from your workstation):

    ssh <docker-host> 'docker exec samsung-tv-art \
        python3 /app/scripts/probe_mattes.py --content-id MY_F2385 MY_F2414'

Notes
- Pass MORE THAN ONE content_id when possible — ideally one landscape and one
  portrait image. A combo is only flagged bad when every probed image rejects
  it, which filters out aspect-ratio-sensitive combos that aren't truly broken.
- The script captures each image's current matte first and restores it at the
  end (best effort). Each combination is briefly displayed on the TV during
  probing, so it'll flicker for a few minutes — don't run during movie night.
- Combinations the TV accepts produce an "ok" log line. Rejections come back
  as `change_matte request failed with error number -7` and get recorded.
- Output JSON shape:
    {
      "probed_at":   "ISO-8601 UTC",
      "content_id":  "MY_F2385",
      "tv_types":    ["none","shadowbox",...],
      "tv_colors":   ["polar","neutral",...],
      "bad_combos":  [["modern","sage"], ["modern","warm"], ...]
    }
"""
import argparse
import asyncio
import json
import os
import socket
import sys
import urllib.request
from datetime import datetime, timezone

# Allow running from anywhere — script lives in scripts/, uploader.py at repo root
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from samsungtvws.async_art import SamsungTVAsyncArt  # noqa: E402


def _is_error_minus_7(exc):
    msg = str(exc)
    return 'error number -7' in msg or "'-7'" in msg or 'errno -7' in msg


def _fetch_device_info(ip, timeout=3.0):
    """Hit the TV's unauthenticated REST endpoint and extract a stable
    identity fingerprint. Returned dict is used to invalidate the matte
    blocklist when the TV model or firmware changes — different firmwares
    accept different (matte_type, color) combos, and the same physical TV
    can change which combos it rejects after a Tizen update.

    Returns {} on any failure (network, JSON, missing keys) — callers should
    treat that as 'unknown identity' and proceed without fingerprinting.
    """
    if not ip:
        return {}
    url = f'http://{ip}:8001/api/v2/'
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            raw = json.loads(r.read().decode('utf-8') or '{}')
    except Exception:
        return {}
    dev = raw.get('device') if isinstance(raw, dict) else None
    if not isinstance(dev, dict):
        return {}
    # Keys vary by firmware; capture everything we plausibly care about.
    # `model` + `firmware_version` are the invalidation drivers; the rest is
    # diagnostic context surfaced through the UI.
    return {
        'model':            dev.get('modelName') or dev.get('model') or '',
        'firmware_version': dev.get('firmwareVersion') or dev.get('version') or '',
        'os':               dev.get('OS') or '',
        'name':             dev.get('name') or '',
        'wifi_mac':         dev.get('wifiMac') or '',
        'type':             dev.get('type') or '',
    }


async def _list_mattes(tv):
    """Return (types, colors) drawn from the TV's own get_matte_list."""
    raw = await tv.get_matte_list(True)
    types, colors = [], []
    if isinstance(raw, (list, tuple)) and len(raw) >= 2:
        types = [m.get('matte_type') for m in raw[0] if isinstance(m, dict) and m.get('matte_type')]
        colors = [m.get('color') for m in raw[1] if isinstance(m, dict) and m.get('color')]
    elif isinstance(raw, dict):
        types = [m.get('matte_type') for m in (raw.get('matte_types') or []) if isinstance(m, dict) and m.get('matte_type')]
        colors = [m.get('color') for m in (raw.get('matte_colors') or []) if isinstance(m, dict) and m.get('color')]
    return types, colors


async def _current_matte(tv, content_id):
    """Best-effort: read the current matte for a content_id so we can restore it."""
    try:
        info = await tv.get_artmode_settings() if hasattr(tv, 'get_artmode_settings') else None
        # Some library versions expose this on the available() list:
        if not info:
            for item in await tv.available('MY-C0002', timeout=10):
                if item.get('content_id') == content_id:
                    return item.get('matte_id') or 'none'
    except Exception:
        pass
    return 'none'


async def probe(args):
    token_file = args.token_file
    if not os.path.exists(token_file):
        print(f'ERROR: token file not found at {token_file}', file=sys.stderr)
        sys.exit(2)

    device_name = os.environ.get('SAMSUNG_TV_ART_DEVICE_NAME') or socket.gethostname() or 'MatteProbe'
    tv_device = _fetch_device_info(args.ip)
    if tv_device:
        print(f"TV identity: model={tv_device.get('model','?')} "
              f"firmware={tv_device.get('firmware_version','?')} "
              f"name={tv_device.get('name','?')}")
    else:
        print('WARN: could not fetch TV /api/v2/ device info; blocklist will not auto-invalidate on firmware change',
              file=sys.stderr)
    tv = SamsungTVAsyncArt(host=args.ip, port=args.port, token_file=token_file, name=device_name)
    await tv.start_listening()

    try:
        types, colors = await _list_mattes(tv)
    except Exception as e:
        print(f'WARN: get_matte_list failed ({e}); falling back to common defaults', file=sys.stderr)
        types = ['none', 'shadowbox', 'modern', 'modernthin', 'modernwide', 'flexible']
        colors = ['polar', 'neutral', 'antique', 'warm', 'ivory', 'cotton', 'sand',
                  'black', 'tinsel', 'apricot', 'coral', 'redorange', 'byzantine',
                  'burgundy', 'flamingo', 'dusty', 'mint', 'sage', 'seafoam',
                  'moss', 'sky', 'powder', 'lavender']

    # Optional explicit overrides
    if args.types:
        types = args.types
    if args.colors:
        colors = args.colors

    content_ids = args.content_id if isinstance(args.content_id, list) else [args.content_id]
    total_calls = len(content_ids) * len(types) * max(len(colors), 1)
    print(f'Probing {len(types)} types × {len(colors)} colors against {len(content_ids)} image(s): '
          f'{content_ids}')
    print(f'  (≈ {total_calls * args.delay:.0f}s of TV flicker, plus retries)')

    async def _try_combo(cid, combo):
        """Return (ok, last_exc). Retries -7 failures up to args.retries extra times."""
        last_exc = None
        attempts = args.retries + 1
        for attempt in range(attempts):
            try:
                await tv.change_matte(cid, combo, portrait_matte=combo)
                return True, None
            except Exception as e:
                last_exc = e
                if not _is_error_minus_7(e):
                    return False, e  # non -7 errors: don't waste retries
                if attempt < attempts - 1:
                    await asyncio.sleep(args.delay)  # back off and retry
        return False, last_exc

    # Track per-combo rejection counts across all probed images.
    # A combo is "bad" only when EVERY image rejected it with -7.
    # NOTE: 'none' is intentionally NOT probed — it's the UI's reset/clear path
    # and the TV often NACKs a redundant 'none' set with -7 when the image
    # already has no matte. We must never blocklist it.
    combos = []  # list of (type, color_or_None, combo_string)
    for t in types:
        if t == 'none':
            continue
        for c in colors:
            combos.append((t, c, f'{t}_{c}'))

    reject_counts = {combo: 0 for _, _, combo in combos}
    other_errors = {combo: None for _, _, combo in combos}

    originals = {}
    for cid in content_ids:
        originals[cid] = await _current_matte(tv, cid)
        print(f'\n=== {cid} (original matte: {originals[cid]}) ===')
        for _, _, combo in combos:
            ok, exc = await _try_combo(cid, combo)
            if ok:
                print(f'  ok    {combo}')
            elif exc is not None and _is_error_minus_7(exc):
                reject_counts[combo] += 1
                print(f'  BAD   {combo}  (rejected {reject_counts[combo]}/{len(content_ids)} images so far)')
            else:
                other_errors[combo] = str(exc)
                print(f'  ERR   {combo}  ({exc})')
            await asyncio.sleep(args.delay)

    bad_combos = []
    good_combos = []
    for t, c, combo in combos:
        if reject_counts[combo] >= len(content_ids):
            bad_combos.append([t, c])
        else:
            good_combos.append([t, c])

    # Restore originals
    for cid, original in originals.items():
        try:
            await tv.change_matte(cid, original, portrait_matte=original)
            print(f'Restored original matte for {cid}: {original}')
        except Exception as e:
            print(f'WARN: could not restore original matte {original} for {cid}: {e}', file=sys.stderr)

    out = {
        'probed_at':   datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'tv_device':   tv_device,
        'content_ids': content_ids,
        'tv_types':    types,
        'tv_colors':   colors,
        'retries':     args.retries,
        'delay':       args.delay,
        'good_count':  len(good_combos),
        'bad_count':   len(bad_combos),
        'bad_combos':  bad_combos,
    }
    os.makedirs(os.path.dirname(args.output) or '.', exist_ok=True)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2)
    print(f'\nWrote {args.output}: {len(good_combos)} ok, {len(bad_combos)} bad')

    try:
        await tv.close()
    except Exception:
        pass


def main():
    p = argparse.ArgumentParser(description='Probe TV for valid matte type+color combinations')
    p.add_argument('--ip', default=os.environ.get('SAMSUNG_TV_ART_TV_IP'),
                   help='TV IP (defaults to $SAMSUNG_TV_ART_TV_IP)')
    p.add_argument('--port', type=int, default=int(os.environ.get('SAMSUNG_TV_ART_PORT', '8002')))
    p.add_argument('--token-file', default='/data/token_file.txt',
                   help='Token file path (default: /data/token_file.txt — container path)')
    p.add_argument('--content-id', required=True, nargs='+',
                   help='One or more uploaded content_ids to probe against. A combo is only '
                        'flagged bad when EVERY image rejects it (filters out aspect-ratio '
                        'sensitive combos). Mix portrait and landscape for best results.')
    p.add_argument('--output', default='/data/matte_blocklist.json',
                   help='Where to write the blocklist JSON (default: /data/matte_blocklist.json)')
    p.add_argument('--delay', type=float, default=0.8,
                   help='Seconds between probes (default: 0.8). Bump higher only if you see '
                        'spurious -7 errors that disappear on retry.')
    p.add_argument('--retries', type=int, default=2,
                   help='Re-test apparent failures N more times before recording them (default: 2)')
    p.add_argument('--types', nargs='*', help='Override matte_types list (skip get_matte_list)')
    p.add_argument('--colors', nargs='*', help='Override matte_colors list')
    args = p.parse_args()
    if not args.ip:
        p.error('--ip is required (or set SAMSUNG_TV_ART_TV_IP)')
    asyncio.run(probe(args))


if __name__ == '__main__':
    main()
