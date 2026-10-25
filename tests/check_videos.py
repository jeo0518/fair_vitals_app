"""Send every test video to a running Fair Vitals and check each result against what should happen.

    python tests/make_videos.py                      # once: makes tests/videos/
    python tests/check_videos.py                     # checks http://localhost:7860
    python tests/check_videos.py --url https://YOUR-SPACE.hf.space
    python tests/check_videos.py clean_72 dark       # only some videos

Each line reads PASS, FAIL or WARN:
  PASS  the app did what it should.
  FAIL  it didn't (e.g. a wrong heart rate, or a confident reading of flicker).
  WARN  not wrong, but worth a look: it refused a clean video (the trust check was stricter than
        needed), or a tip we'd expect was missing.
For clean videos the line also shows the POS reading (the classic method, from the per-window table),
so you can tell a pipeline problem (POS wrong too) from a trust-model decision (POS right, app refused).
Uses only the Python standard library.
"""
import argparse, json, os, statistics, sys, time, urllib.error, urllib.request, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
CLOSE = 5          # BPM: a reading this close to the true rate counts as right


def post_video(url, path):
    """POST the file to /analyze as a form upload; returns (HTTP status, JSON answer or None, seconds)."""
    boundary = uuid.uuid4().hex
    with open(path, 'rb') as fh:
        data = fh.read()
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="video"; filename="{os.path.basename(path)}"\r\n'
            f'Content-Type: application/octet-stream\r\n\r\n').encode() + data + f'\r\n--{boundary}--\r\n'.encode()
    req = urllib.request.Request(url.rstrip('/') + '/analyze', data=body, method='POST',
                                 headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=900) as res:
            status, text = res.status, res.read().decode()
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read().decode(errors='replace')
    try:
        answer = json.loads(text)
    except ValueError:
        answer = None
    return status, answer, time.time() - t0


def judge(expect, status, r):
    """(verdict, what happened) for one video."""
    if r is None:
        return 'FAIL', f'no JSON answer (HTTP {status})'
    bpm, tips = r.get('heart_rate_bpm'), ' '.join(r.get('tips', [])).lower()
    windows = r.get('readings', [])
    pos = statistics.median(w['hr_pos'] for w in windows) if windows else None
    got = (f'{bpm} BPM' if bpm is not None else 'no reading') + (f', trust {r["trust_score"] * 100:.0f}%' if 'trust_score' in r else '')
    if pos is not None:
        got += f', POS {pos:.1f}'
    if not r.get('ok') and not windows:
        got = f'message: {r.get("message", "")!r}'
    problems, warnings = [], []

    if 'error' in expect:
        if r.get('ok') or windows:
            problems.append('expected an error message')
        elif expect['error'].lower() not in r.get('message', '').lower():
            problems.append(f'message should mention {expect["error"]!r}')
    if 'reading' in expect:
        truth = expect['reading']
        if bpm is not None and abs(bpm - truth) > CLOSE:
            problems.append(f'heart rate off by {abs(bpm - truth):.1f} (true {truth})')
        elif bpm is None:
            if pos is not None and abs(pos - truth) <= CLOSE:
                warnings.append('refused a clean video (POS was right: the trust check was strict)')
            else:
                problems.append(f'no reading, and POS was wrong too (true {truth})')
    if expect.get('no_reading') and bpm is not None:
        problems.append('gave a reading for a video it should refuse')
    if 'no_reading_at' in expect and bpm is not None and abs(bpm - expect['no_reading_at']) <= 10:
        problems.append(f'confidently reported {bpm} BPM, which is the flicker, not a pulse')
    if expect.get('flicker') and windows and not any(w.get('flicker') for w in windows):
        warnings.append('flicker was not flagged in any window')
    if 'tip' in expect and r.get('ok') and bpm is None and expect['tip'] not in tips:
        warnings.append(f'expected a tip about {expect["tip"]!r}')
    if problems:
        return 'FAIL', got + ' | ' + '; '.join(problems + warnings)
    if warnings:
        return 'WARN', got + ' | ' + '; '.join(warnings)
    return 'PASS', got


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('names', nargs='*', help='only these videos (default: all)')
    ap.add_argument('--url', default='http://localhost:7860', help='where Fair Vitals is running')
    ap.add_argument('--videos', default=os.path.join(HERE, 'videos'), help='folder made by make_videos.py')
    args = ap.parse_args()
    try:
        cases = json.load(open(os.path.join(args.videos, 'expected.json')))
    except FileNotFoundError:
        sys.exit('No test videos yet. Run: python tests/make_videos.py')
    try:
        urllib.request.urlopen(args.url.rstrip('/') + '/health', timeout=60).read()
    except Exception as e:
        sys.exit(f'Fair Vitals is not answering at {args.url} ({e}). Start it, or pass --url.')

    counts = {'PASS': 0, 'WARN': 0, 'FAIL': 0}
    print(f'Checking {args.url}\n')
    for name, case in cases.items():
        if args.names and name not in args.names:
            continue
        path = os.path.join(args.videos, case['file'])
        size = os.path.getsize(path) / 2 ** 20
        print(f'{name:17s} {size:6.1f} MB  ', end='', flush=True)
        status, answer, secs = post_video(args.url, path)
        verdict, got = judge(case['expect'], status, answer)
        counts[verdict] += 1
        print(f'{secs:5.0f} s  {verdict}  {got}')
        print(f'{"":17s} {case["about"]}')
    print(f'\n{counts["PASS"]} passed, {counts["WARN"]} warnings, {counts["FAIL"]} failed')
    sys.exit(1 if counts['FAIL'] else 0)


if __name__ == '__main__':
    main()
