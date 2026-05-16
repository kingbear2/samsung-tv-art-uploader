#!/usr/bin/env python3
"""Probe every (matte_type, color) combination against the live TV and record
which ones the TV rejects with error -7.

Designed to run **inside the container** so it reuses the existing
/app/token_file.txt and writes to /data/matte_blocklist.json (which serve.py
exposes at /api/matte_blocklist for the web UI to consume).

Typical usage (from your workstation):

    ssh <docker-host> 'docker exec samsung-tv-art \
        python3 /app/scripts/probe_mattes.py --content-id MY_F2385'

Notes
- A real content_id is required. Pick any one of your uploaded images; the
  script captures the current matte first and restores it at the end (best
  effort). Each combination is briefly displayed on the TV during probing,
  so it'll flicker for a few minutes — don't run during movie night.
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
from datetime import datetime, timezone

# Allow running from anywhere — script lives in scripts/, uploader.py at repo root
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from samsungtvws.async_art import SamsungTVAsyncArt  # noqa: E402


def _is_error_minus_7(exc):
    msg = str(exc)
    return 'error number -7' in msg or "'-7'" in msg or 'errno -7' in msg


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

    print(f'Probing {len(types)} types × {len(colors)} colors on content_id={args.content_id} '
          f'(≈ {len(types) * len(colors) * args.delay:.0f}s of TV flicker)…')

    original = await _current_matte(tv, args.content_id)
    print(f'Original matte for {args.content_id}: {original}')

    bad_combos = []
    good_combos = []

    for t in types:
        if t == 'none':
            # 'none' has no color — test it once outside the color loop
            try:
                await tv.change_matte(args.content_id, 'none', portrait_matte='none')
                good_combos.append(['none', None])
                print(f'  ok    none')
            except Exception as e:
                if _is_error_minus_7(e):
                    bad_combos.append(['none', None])
                    print(f'  BAD   none  ({e})')
                else:
                    print(f'  ERR   none  ({e})')
            await asyncio.sleep(args.delay)
            continue
        for c in colors:
            combo = f'{t}_{c}'
            try:
                await tv.change_matte(args.content_id, combo, portrait_matte=combo)
                good_combos.append([t, c])
                print(f'  ok    {combo}')
            except Exception as e:
                if _is_error_minus_7(e):
                    bad_combos.append([t, c])
                    print(f'  BAD   {combo}')
                else:
                    print(f'  ERR   {combo}  ({e})')
            await asyncio.sleep(args.delay)

    # Restore
    try:
        await tv.change_matte(args.content_id, original, portrait_matte=original)
        print(f'Restored original matte: {original}')
    except Exception as e:
        print(f'WARN: could not restore original matte {original}: {e}', file=sys.stderr)

    out = {
        'probed_at':  datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'content_id': args.content_id,
        'tv_types':   types,
        'tv_colors':  colors,
        'good_count': len(good_combos),
        'bad_count':  len(bad_combos),
        'bad_combos': bad_combos,
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
    p.add_argument('--token-file', default='/app/token_file.txt',
                   help='Token file path (default: /app/token_file.txt — container path)')
    p.add_argument('--content-id', required=True,
                   help='An uploaded image content_id to probe against (e.g. MY_F2385)')
    p.add_argument('--output', default='/data/matte_blocklist.json',
                   help='Where to write the blocklist JSON (default: /data/matte_blocklist.json)')
    p.add_argument('--delay', type=float, default=0.8,
                   help='Seconds between probes — too short and the TV may queue or 429 (default: 0.8)')
    p.add_argument('--types', nargs='*', help='Override matte_types list (skip get_matte_list)')
    p.add_argument('--colors', nargs='*', help='Override matte_colors list')
    args = p.parse_args()
    if not args.ip:
        p.error('--ip is required (or set SAMSUNG_TV_ART_TV_IP)')
    asyncio.run(probe(args))


if __name__ == '__main__':
    main()
