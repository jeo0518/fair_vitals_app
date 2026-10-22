# Video helper: decodes a video with ffmpeg, finds the face (YuNet, Haar, or centre crop),
# and writes 64x64 face crops + per-frame stats. Runs as a separate process so a crash in
# native video/face code can never take down the web server. Identical to the trust-score notebook.
import sys, os, json, csv, subprocess, tempfile
import numpy as np
job = json.loads(sys.argv[1])
import cv2
cv2.setNumThreads(1)
FPS, SIZE, DET_EVERY = job['fps'], job['img_size'], job['det_every']

det_kind = job['detector']
if det_kind == 'yunet':
    yunet = cv2.FaceDetectorYN.create(job['yunet_path'], '', (320, 320), 0.6)
elif det_kind == 'haar':
    haar = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

def detect(rgb):
    if det_kind == 'none':
        return None
    h, w, _ = rgb.shape
    s = 480 / max(h, w) if max(h, w) > 480 else 1.0
    small = cv2.resize(rgb, (int(w * s), int(h * s))) if s < 1 else np.ascontiguousarray(rgb)
    if det_kind == 'yunet':
        yunet.setInputSize((small.shape[1], small.shape[0]))
        _, faces = yunet.detect(cv2.cvtColor(small, cv2.COLOR_RGB2BGR))
        if faces is None or len(faces) == 0:
            return None
        x, y, fw, fh = max(faces[:, :4].tolist(), key=lambda f: f[2] * f[3])
    else:
        faces = haar.detectMultiScale(cv2.cvtColor(small, cv2.COLOR_RGB2GRAY), 1.1, 5, minSize=(40, 40))
        if len(faces) == 0:
            return None
        x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
    return ((x + fw / 2) / s, (y + fh / 2) / s, max(fw, fh) / s)

def stats_row(k, det, w, h, crop):
    g = crop.mean(-1)
    clip = float(((crop > 250).any(-1) | (crop < 5).all(-1)).mean())
    return [k % DET_EVERY == 0, det is not None,
            det[0] / w if det else '', det[1] / h if det else '', det[2] / min(h, w) if det else '',
            float(g.mean()), clip]

rows, out = [], []
if job['mode'] == 'video':
    path = job['path']
    pr = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                         'stream=width,height,avg_frame_rate:stream_tags=rotate:stream_side_data=rotation:format=duration',
                         '-of', 'json', path], capture_output=True, text=True)
    if pr.returncode != 0:
        sys.exit('ffprobe failed: ' + pr.stderr[:300])
    info = json.loads(pr.stdout); st = info['streams'][0]
    w, h = int(st['width']), int(st['height'])
    # Phones store portrait video sideways plus a rotation tag; ffmpeg applies it, so swap the size to match.
    rot = st.get('tags', {}).get('rotate') or next((d.get('rotation') for d in st.get('side_data_list', []) if 'rotation' in d), 0)
    if abs(int(float(rot or 0))) % 180 == 90:
        w, h = h, w
    # Shrink big videos (web app only) so analysis is fast on a CPU server.
    max_side = job.get('max_side')
    if max_side and max(w, h) > max_side:
        s_ = max_side / max(w, h); w, h = int(w * s_) // 2 * 2, int(h * s_) // 2 * 2
    num, den = (st.get('avg_frame_rate') or '30/1').split('/')
    fps_src = float(num) / float(den) if float(den) else FPS
    duration = float(info.get('format', {}).get('duration', 0) or 0)
    err = tempfile.TemporaryFile()
    proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', '-threads', os.environ.get('FV_THREADS', '2'), '-i', path, '-t', str(job['max_sec']),
                             '-vf', f'fps={FPS},scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
                            stdout=subprocess.PIPE, stderr=err, bufsize=10 ** 8)
    recent, k, nbytes = [], 0, w * h * 3
    while True:
        buf = proc.stdout.read(nbytes)
        if len(buf) < nbytes:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
        det = detect(rgb) if k % DET_EVERY == 0 else None
        if det:
            recent = (recent + [det])[-10:]
        if recent:
            cx, cy, side = np.median(np.array(recent), axis=0)
        else:
            cx, cy, side = w / 2, h / 2, 0.6 * min(h, w) / 1.5
        s = int(min(side * 1.5, h, w))
        x1 = int(np.clip(cx - s / 2, 0, w - s)); y1 = int(np.clip(cy - s / 2, 0, h - s))
        crop = cv2.resize(np.ascontiguousarray(rgb[y1:y1 + s, x1:x1 + s]), (SIZE, SIZE), interpolation=cv2.INTER_AREA)
        rows.append(stats_row(k, det, w, h, crop)); out.append(crop); k += 1
    proc.stdout.close(); proc.wait()
    if not out:
        err.seek(0); sys.exit('ffmpeg decoded no frames: ' + err.read().decode()[:300])
    np.save(job['out'] + '_frames.npy', np.stack(out))
else:                                   # already-cropped clip (UCLA): only compute the stats
    frames = np.load(job['path'], mmap_mode='r')[:int(job['max_sec'] * FPS)]
    fps_src, duration = FPS, len(frames) / FPS
    for k in range(len(frames)):
        fr = np.ascontiguousarray(frames[k])
        det = detect(cv2.resize(fr, (256, 256), interpolation=cv2.INTER_CUBIC)) if k % DET_EVERY == 0 else None
        if det: det = (det[0] * fr.shape[1] / 256, det[1] * fr.shape[0] / 256, det[2] * fr.shape[0] / 256)
        rows.append(stats_row(k, det, fr.shape[1], fr.shape[0], fr))

with open(job['out'] + '_stats.csv', 'w', newline='') as fh:
    wr = csv.writer(fh)
    wr.writerow(['det_try', 'det_ok', 'det_cx', 'det_cy', 'det_side', 'lum', 'clip_frac'])
    wr.writerows(rows)
print(json.dumps({'fps_src': fps_src, 'duration': duration, 'n': len(rows)}))
