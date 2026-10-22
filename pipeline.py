"""Fair Vitals analysis pipeline: selfie video -> heart rate + trust score.

Models, readings and trust features all come from fair_vitals_core.py, the exact code the trust-refiner
notebook checked against its training numbers. This file only adds video decoding (worker.py), scoring
every 10-second window, and the summary + tips the web page shows.
Models are read from ./models:
  - stage2_ucla_best.pt           (Stage 2 CNN: the trust model's second opinion)
  - pos_refiner.pt                (POS-refiner: the heart rate the app shows)
  - trust_model_refiner.joblib    (trust model trained on the refiner's readings)
  - face_detection_yunet_2023mar.onnx (downloaded automatically if missing)
"""
import os, sys, json, subprocess, tempfile, shutil, urllib.request
import numpy as np
import pandas as pd
import fair_vitals_core as fv

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.environ.get('FV_MODEL_DIR', os.path.join(HERE, 'models'))
WORKER = os.path.join(HERE, 'worker.py')
YUNET = os.path.join(MODEL_DIR, 'face_detection_yunet_2023mar.onnx')

FPS = fv.FPS
MAX_SEC = 60          # analyse at most the first 60 s of a video
DARK_LUM = 45         # face-centre brightness (0-255) below which we ask for more light (app rule, not the model)

# ---------------------------------------------------------------- models
class Models:
    def __init__(self):
        if not os.path.exists(YUNET) or os.path.getsize(YUNET) < 100_000:
            try: urllib.request.urlretrieve(fv.YUNET_URL, YUNET)
            except Exception as e: print('YuNet download failed (will fall back to another detector):', e)
        m = fv.load_models(MODEL_DIR, yunet_path=None)
        self.core = m
        self.estimate, self.threshold, self.trust_file = m.trust_estimate, m.threshold, m.trust_file
        self.cnn_name = f'stage2_ucla_best.pt ({m.cnn_base}) + pos_refiner.pt'
        self.device = str(m.device)

# ---------------------------------------------------------------- video -> face crops (helper process)
def face_clip(video_path, workdir):
    out = os.path.join(workdir, 'clip')
    errors = []
    for det in ('yunet', 'haar', 'none'):
        job = {'mode': 'video', 'path': video_path, 'out': out, 'detector': det, 'yunet_path': YUNET,
               'fps': FPS, 'img_size': fv.IMG_SIZE, 'det_every': fv.DET_EVERY, 'max_sec': MAX_SEC,
               'max_side': 960}
        r = subprocess.run([sys.executable, WORKER, json.dumps(job)], capture_output=True, text=True)
        if r.returncode == 0:
            frames = np.load(out + '_frames.npy'); stats = pd.read_csv(out + '_stats.csv')
            return frames, stats, det
        errors.append(f'{det}: {(r.stderr or r.stdout).strip().splitlines()[-1:] or ["?"]}')
    raise RuntimeError('Could not read the video. ' + ' | '.join(errors))

# ---------------------------------------------------------------- tips (simple rules; tune later)
def tips_for(rejected, dark):
    tips = []
    if dark:
        tips.append('Your face looks too dark. Move to brighter, even light (e.g. face a window).')
    if len(rejected):
        med = rejected.median(numeric_only=True)
        if med.get('face_found', 1) < 0.8: tips.append('Keep your whole face in the frame.')
        if med.get('motion_xy', 0) > 0.03 or med.get('frame_change', 0) > 0.03: tips.append('Hold still and keep your phone steady.')
        if rejected.flicker_flag.mean() > 0.3: tips.append('The lighting seems to flicker. Try daylight or a different lamp.')
        if med.get('light_change', 0) > 0.03: tips.append('Avoid changing light (screens, moving shadows).')
        if not tips: tips.append('The pulse signal was weak. Try brighter light, hold the phone closer, and stay still.')
    return tips

# ---------------------------------------------------------------- main entry
def analyze(video_path, models):
    workdir = tempfile.mkdtemp(prefix='fv_')
    try:
        frames, stats, detector = face_clip(video_path, workdir)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    W, S = fv.WIN_SEC * FPS, fv.STRIDE_SEC * FPS
    if len(frames) < W:
        return {'ok': False, 'message': f'The video is too short. Please record at least {fv.WIN_SEC} seconds '
                                         f'(this one is {len(frames) / FPS:.1f} s).'}
    rows = []
    for s in range(0, len(frames) - W + 1, S):
        fr = np.asarray(frames[s:s + W])
        r = fv.window_features(models.core, fr, stats.iloc[s:s + W])
        r['p_reliable'] = fv.trust_score(models.core, r)
        r['face_brightness'] = float(fv.ring_and_center(fr)[1].mean())   # app rule only, never a model input
        r['start_s'] = s / FPS; rows.append(r)
    df = pd.DataFrame(rows)
    df['reliable'] = df.p_reliable >= models.threshold
    dark = bool(df.face_brightness.median() < DARK_LUM)

    acc = df[df.reliable]
    result = {
        'ok': True,
        'duration_s': round(len(frames) / FPS, 1),
        'readings_total': int(len(df)),
        'readings_reliable': int(len(acc)),
        'trust_score': round(float(df.p_reliable.median()), 3),        # 0-1, median over all 10 s readings
        'threshold': float(models.threshold),
        'heart_rate_bpm': round(float(acc.hr_app.median()), 1) if len(acc) else None,
        'verdict': 'reliable' if len(acc) else 'unreliable',
        'tips': tips_for(df[~df.reliable], dark),
        'details': {'estimate': models.estimate, 'cnn': models.cnn_name, 'face_detector': detector,
                    'device': models.device},
        'readings': [{'start_s': round(r.start_s, 1), 'hr_bpm': round(r.hr_app, 1),
                      'p_reliable': round(r.p_reliable, 3), 'reliable': bool(r.reliable),
                      'hr_cnn': round(r.hr_cnn_raw, 1), 'hr_pos': round(r.hr_pos_raw, 1),
                      'flicker': bool(r.flicker_flag)} for r in df.itertuples()],
    }
    if not len(acc):
        result['message'] = "We couldn't get a reliable reading from this video."
    return result
