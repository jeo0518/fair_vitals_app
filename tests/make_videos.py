"""Make synthetic test videos for Fair Vitals, with a known heart rate and known problems.

    python tests/make_videos.py            # writes tests/videos/*.mp4 (and .mov) plus tests/videos/expected.json

The face is tests/face.jpg: NASA's public-domain portrait of astronaut Eileen Collins (the "astronaut" test
image that ships with scikit-image). Each frame, the skin's color is changed very slightly at an exact
heart rate, mostly in green, the way a real pulse shows up on camera; then camera noise, compression and
the case's problem (darkness, flicker, movement, ...) are added.

What these videos are for: checking that the app behaves sensibly (reads a clean pulse, refuses bad
video, gives the right tip, copes with phone-style files). What they are NOT for: judging accuracy or
fairness. A still photo with a clean, made-up pulse is far easier than real skin.

Needs numpy, opencv and ffmpeg (all already used by the app).
"""
import json, os, subprocess, sys
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'videos')
W, H, FPS = 1280, 720, 30
PULSE_RGB = np.array([0.33, 0.77, 0.53])     # how a pulse changes skin color (mostly green), roughly as in rPPG papers
rng = np.random.default_rng(0)


# ---------------------------------------------------------------- the scene
def base_frame():
    """The portrait centered on a plain backdrop, and a soft mask of the facial skin (where the pulse shows)."""
    photo = cv2.imread(os.path.join(HERE, 'face.jpg')).astype(np.float32)        # BGR, 512 x 512
    s = H / 512
    photo = cv2.resize(photo, (int(512 * s), H), interpolation=cv2.INTER_CUBIC)
    frame = np.empty((H, W, 3), np.float32); frame[:] = (150, 156, 160)          # gray-blue backdrop
    x0 = (W - photo.shape[1]) // 2
    frame[:, x0:x0 + photo.shape[1]] = photo
    # the face box YuNet finds on the 512 px photo: x 178, y 63, w 90, h 113
    cx, cy = x0 + (178 + 45) * s, (63 + 62) * s
    mask = np.zeros((H, W), np.float32)
    cv2.ellipse(mask, (int(cx), int(cy)), (int(40 * s), int(54 * s)), 0, 0, 360, 1, -1)
    b, g, r = frame[..., 0], frame[..., 1], frame[..., 2]
    skin = ((r > 95) & (g > 40) & (b > 20) & (r > g) & (r > b) & (r - np.minimum(g, b) > 15)).astype(np.float32)
    mask = cv2.GaussianBlur(mask * skin, (0, 0), 3)
    return frame, mask


def pulse_wave(t, bpm):
    """A pulse-like wave (sharp rise, slower fall) with a little natural variation in rate."""
    phase = 2 * np.pi * np.cumsum(np.full_like(t, bpm / 60 / FPS) * (1 + 0.02 * np.sin(2 * np.pi * 0.1 * t)))
    return np.sin(phase) + 0.35 * np.sin(2 * phase - 0.6) + 0.1 * np.sin(3 * phase - 1.2)


def frames(sec, bpm, *, amp=0.010, gain=1.0, face_gain=1.0, bg_gain=1.0, flicker=None, shake=0.0, no_face=False):
    """Yield BGR uint8 frames. amp: pulse strength (share of skin brightness). gain: overall exposure.
    face_gain / bg_gain: brightness of the face area vs the rest (for a dim face against a bright window).
    flicker: (bpm, strength) of lighting flicker over the whole scene. shake: how much the camera moves (px)."""
    base, mask = base_frame()
    if no_face:
        base = cv2.GaussianBlur(base, (0, 0), 25)        # a soft, featureless scene: nothing to detect
        mask[:] = 0
    face_area = cv2.GaussianBlur((mask > 0.05).astype(np.float32), (0, 0), 40)[..., None]
    light = face_gain * face_area + bg_gain * (1 - face_area)
    n = int(sec * FPS); t = np.arange(n) / FPS
    wave = pulse_wave(t, bpm) if bpm else np.zeros(n)
    walk = np.cumsum(rng.normal(0, 1, (n, 3)), axis=0)
    walk -= np.linspace(0, 1, n)[:, None] * walk[-1]                              # drifts, then comes back
    for k in range(n):
        f = base * (1 + amp * wave[k] * mask[..., None] * PULSE_RGB)
        f = f * light * gain
        if flicker:
            f = f * (1 + flicker[1] * np.sin(2 * np.pi * flicker[0] / 60 * t[k]))
        if shake:
            dx, dy, da = walk[k] * shake / max(1, np.abs(walk).max()) * np.array([1, 1, 0.05])
            m = cv2.getRotationMatrix2D((W / 2, H / 2), da, 1.0); m[:, 2] += (dx, dy)
            f = cv2.warpAffine(f, m, (W, H), borderMode=cv2.BORDER_REFLECT)
        f = f + rng.normal(0, 2.0, f.shape)                                       # camera noise
        yield np.clip(f, 0, 255).astype(np.uint8)


# ---------------------------------------------------------------- writing files
def write(name, frame_iter, *, codec='libx264', ext='mp4', size=None, fps=FPS, rotate=None, extra=()):
    path = os.path.join(OUT, f'{name}.{ext}')
    vf = [f'scale={size[0]}:{size[1]}:flags=bicubic'] if size else []
    if rotate:                                                                    # stored sideways + a rotation tag, like a phone
        vf.append('transpose=1')                                                  # turned clockwise; the tag turns it back
    cmd = ['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', str(fps), '-i', '-',
           *(['-vf', ','.join(vf)] if vf else []), '-c:v', codec, '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'veryfast',
           *extra, path]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for f in frame_iter:
        proc.stdin.write(f.tobytes())
    proc.stdin.close()
    if proc.wait():
        sys.exit(f'ffmpeg failed for {name}')
    if rotate:                                                                    # add the rotation tag without re-encoding
        tagged = path + '.tmp.' + ext
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-display_rotation', str(rotate), '-i', path, '-c', 'copy', tagged], check=True)
        os.replace(tagged, path)
    return os.path.basename(path)


def frames_60(sec, bpm, **kw):
    """The same scene at 60 frames a second (each frame shown twice; the pulse is still smooth enough)."""
    for f in frames(sec, bpm, **kw):
        yield f
        yield f


# ---------------------------------------------------------------- the cases
CASES = [
    # name, what it is, expectation, how to make it
    ('clean_72', 'Clean video, still face, steady light, pulse 72 BPM.',
     {'reading': 72}, lambda: write('clean_72', frames(30, 72))),
    ('clean_58', 'Clean video, pulse 58 BPM (slow).',
     {'reading': 58}, lambda: write('clean_58', frames(30, 58))),
    ('clean_96', 'Clean video, pulse 96 BPM (fast).',
     {'reading': 96}, lambda: write('clean_96', frames(30, 96))),
    ('short_8s', 'Only 8 seconds long.',
     {'error': 'too short'}, lambda: write('short_8s', frames(8, 72))),
    ('no_face', 'A blurry scene with no face in it.',
     {'no_reading': True, 'tip': 'face'}, lambda: write('no_face', frames(25, 72, no_face=True))),
    ('dark', 'Whole scene badly underexposed.',
     {'no_reading': True, 'tip': 'dark'}, lambda: write('dark', frames(25, 72, gain=0.18))),
    ('backlit', 'Dim face in front of a bright background, like the hardest real test case.',
     {'tip': 'behind'}, lambda: write('backlit', frames(25, 72, face_gain=0.3, bg_gain=1.5, amp=0.006))),
    ('flicker_125', 'Lights flickering at 125 BPM over a weak 72 BPM pulse.',
     {'no_reading_at': 125, 'flicker': True}, lambda: write('flicker_125', frames(25, 72, amp=0.003, flicker=(125, 0.03)))),
    ('shaky', 'Hand-held: the camera wanders and shakes.',
     {'no_reading': True, 'truth': 72, 'tip': 'still'}, lambda: write('shaky', frames(25, 72, shake=60))),
    ('portrait_rotated', 'Clean 72 BPM, stored sideways with a rotation tag, like a phone in portrait.',
     {'reading': 72}, lambda: write('portrait_rotated', frames(25, 72), rotate=90)),
    ('iphone_hevc', 'Clean 72 BPM as an HEVC .mov file, like an iPhone.',
     {'reading': 72}, lambda: write('iphone_hevc', frames(25, 72), codec='libx265', ext='mov', extra=('-tag:v', 'hvc1', '-x265-params', 'log-level=error'))),
    ('big_4k60', 'Clean 72 BPM at 4K and 60 frames a second (a large file).',
     {'reading': 72}, lambda: write('big_4k60', frames_60(20, 72), size=(3840, 2160), fps=60)),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    only = set(sys.argv[1:])
    expected = {}
    path = os.path.join(OUT, 'expected.json')
    if os.path.exists(path):
        expected = json.load(open(path))
    for name, about, expect, make in CASES:
        if only and name not in only:
            continue
        print(f'making {name}…', flush=True)
        expected[name] = {'file': make(), 'about': about, 'expect': expect}
    with open(os.path.join(OUT, 'not_a_video.mp4'), 'w') as fh:                    # a text file pretending to be a video
        fh.write('this is not a video\n')
    expected['not_a_video'] = {'file': 'not_a_video.mp4', 'about': 'A text file named .mp4.', 'expect': {'error': 'open that file'}}
    json.dump(expected, open(path, 'w'), indent=2)
    total = sum(os.path.getsize(os.path.join(OUT, e['file'])) for e in expected.values()) / 2 ** 20
    print(f'done: {len(expected)} files in {OUT} ({total:.0f} MB)')


if __name__ == '__main__':
    main()
