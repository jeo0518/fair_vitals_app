"""Fair Vitals analysis pipeline: selfie video -> heart rate + trust score.

Mirrors fair_vitals_trust_score.ipynb exactly (same face crops, same 17 features, same
heart-rate estimate), so the web app behaves the way the evaluation measured.
Models are read from ./models:
  - trust_model_refiner.joblib    (from the trust-score notebook)
  - the CNN checkpoint            (pos_refiner.pt)
  - face_detection_yunet_2023mar.onnx (downloaded automatically if missing)
"""
import os, sys, json, subprocess, tempfile, shutil, urllib.request
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import joblib
from scipy.signal import butter, filtfilt, find_peaks

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.environ.get('FV_MODEL_DIR', os.path.join(HERE, 'models'))
WORKER = os.path.join(HERE, 'worker.py')
TRUST_FILE = 'trust_model_refiner.joblib'
CNN_FILE = 'pos_refiner.pt'       # used when the checkpoint named inside the trust model isn't in ./models
YUNET = os.path.join(MODEL_DIR, 'face_detection_yunet_2023mar.onnx')
YUNET_URL = 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx'

FPS = 30
MAX_SEC = 60          # analyse at most the first 60 s of a video
DET_EVERY = 6         # face detection 5 times per second
STRIDE_SEC = 5
DARK_LUM = 45         # face-centre brightness (0-255) below which we ask for more light (app rule, not the model)
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

# ---------------------------------------------------------------- models (same definitions as the notebooks)
class PulseModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv1 = nn.Conv3d(3, 32, kernel_size=(5, 3, 3), padding=(2, 1, 1)); self.bn1 = nn.BatchNorm3d(32)
        self.conv2 = nn.Conv3d(32, 64, kernel_size=(5, 3, 3), padding=(2, 1, 1)); self.bn2 = nn.BatchNorm3d(64)
        self.conv3 = nn.Conv3d(64, 128, kernel_size=(5, 3, 3), padding=(4, 1, 1), dilation=(2, 1, 1)); self.bn3 = nn.BatchNorm3d(128)
        self.conv4 = nn.Conv3d(128, 128, kernel_size=(5, 3, 3), padding=(8, 1, 1), dilation=(4, 1, 1)); self.bn4 = nn.BatchNorm3d(128)
        self.shrink = nn.AvgPool3d(kernel_size=(1, 2, 2))
        self.face_average = nn.AdaptiveAvgPool3d((None, 1, 1))
        self.to_pulse = nn.Conv1d(128, 1, kernel_size=1)
    def forward(self, x):
        x = self.shrink(torch.relu(self.bn1(self.conv1(x))))
        x = self.shrink(torch.relu(self.bn2(self.conv2(x))))
        x = torch.relu(self.bn3(self.conv3(x)))
        x = torch.relu(self.bn4(self.conv4(x)))
        return self.to_pulse(self.face_average(x).squeeze(-1).squeeze(-1)).squeeze(1)

def _conv_bn(cin, cout, k=(3, 3, 3)):
    return nn.Sequential(nn.Conv3d(cin, cout, k, padding=tuple(s // 2 for s in k), bias=False),
                         nn.BatchNorm3d(cout), nn.ReLU(inplace=True))
class PhysNet3D(nn.Module):
    def __init__(self, width=32, dropout=0.2):
        super().__init__(); w = width
        self.features = nn.Sequential(
            _conv_bn(3, w // 2, (1, 5, 5)), nn.MaxPool3d((1, 2, 2)),
            _conv_bn(w // 2, w), _conv_bn(w, w), nn.MaxPool3d((1, 2, 2)),
            _conv_bn(w, 2 * w), _conv_bn(2 * w, 2 * w), nn.MaxPool3d((1, 2, 2)),
            _conv_bn(2 * w, 2 * w), _conv_bn(2 * w, 2 * w), nn.AdaptiveAvgPool3d((None, 1, 1)))
        self.head = nn.Sequential(nn.Conv1d(2 * w, 2 * w, 5, padding=2), nn.BatchNorm1d(2 * w),
                                  nn.ReLU(inplace=True), nn.Dropout(dropout), nn.Conv1d(2 * w, 1, 1))
    def forward(self, x):
        return self.head(self.features(x).flatten(2)).squeeze(1)

def _prep_stage1(frames):
    f = frames.astype(np.float32) / 255.0
    f = f - f.mean(axis=0); return f / (f.std() + 1e-6)
def _prep_physnet(frames):
    f = frames.astype(np.float32) / 255.0 + 1e-3
    d = (f[1:] - f[:-1]) / (f[1:] + f[:-1]); d = d / (d.std() + 1e-8)
    return np.concatenate([d, np.zeros_like(d[:1])], axis=0)

ESTIMATES = {'CNN': 'hr_cnn_raw', 'CNN, flicker-corrected': 'hr_cnn_clean',
             'POS (face centre)': 'hr_pos_raw', 'POS, flicker-corrected': 'hr_pos_clean'}

class Models:
    def __init__(self):
        self.trust = joblib.load(os.path.join(MODEL_DIR, TRUST_FILE))
        ckpt_name = self.trust.get('cnn_checkpoint', CNN_FILE)
        if not os.path.exists(os.path.join(MODEL_DIR, ckpt_name)):
            ckpt_name = CNN_FILE
        ck = torch.load(os.path.join(MODEL_DIR, ckpt_name), map_location=device, weights_only=False)
        self.base, self.img_size = ck['base'], ck['img_size']
        self.cnn = (PulseModel() if self.base == 'stage1' else PhysNet3D()).to(device)
        self.cnn.load_state_dict(ck['model']); self.cnn.eval()
        self.prep = _prep_stage1 if self.base == 'stage1' else _prep_physnet
        self.to_pulse = (lambda o: o) if self.base == 'stage1' else np.cumsum
        self.win_sec = self.trust.get('window_sec', 10)
        self.estimate = self.trust.get('estimate', 'CNN')
        self.features = self.trust['features']
        self.missing = self.trust.get('missing_value', -1.0)
        self.threshold = self.trust['threshold']
        self.cnn_name = ckpt_name
        if not os.path.exists(YUNET) or os.path.getsize(YUNET) < 100_000:
            try: urllib.request.urlretrieve(YUNET_URL, YUNET)
            except Exception as e: print('YuNet download failed (will fall back to another detector):', e)

    @torch.no_grad()
    def cnn_pulse(self, frames):
        x = torch.from_numpy(np.ascontiguousarray(self.prep(frames).transpose(3, 0, 1, 2)))[None].to(device)
        return self.to_pulse(self.cnn(x).float().cpu().numpy()[0])

# ---------------------------------------------------------------- signal tools (identical to the trust notebook)
LO, HI = 0.7, 3.0
def bandpass(x, fs=FPS, lo=LO, hi=HI, order=2):
    b, a = butter(order, [lo / (fs / 2), hi / (fs / 2)], btype='band')
    return filtfilt(b, a, np.asarray(x, dtype=np.float64))

def spectrum(x):
    x = bandpass(x); n = max(8 * len(x), 8192)
    p = np.abs(np.fft.rfft((x - x.mean()) * np.hanning(len(x)), n)) ** 2
    f = np.fft.rfftfreq(n, 1 / FPS); band = (f >= LO) & (f <= 4.0)
    return f[band], p[band]

def hr_quality(x):
    f, p = spectrum(x); inb = f <= HI
    f0 = f[inb][np.argmax(p[inb])]
    near = (np.abs(f - f0) <= 0.1) | (np.abs(f - 2 * f0) <= 0.2)
    snr = 10 * np.log10(p[near].sum() / (p[~near].sum() + 1e-12) + 1e-12)
    pk, _ = find_peaks(p[inb]); hts = np.sort(p[inb][pk])[::-1] if len(pk) else np.array([1.0])
    ratio = float(hts[0] / hts[1]) if len(hts) > 1 else 10.0
    return float(f0 * 60), float(snr), min(ratio, 10.0)

def pos_signal(rgb, win_sec=1.6):
    T, l = len(rgb), int(win_sec * FPS); H = np.zeros(T)
    P = np.array([[0, 1, -1], [-2, 1, 1]], dtype=np.float64)
    for n in range(T - l + 1):
        C = rgb[n:n + l].T; C = C / (C.mean(1, keepdims=True) + 1e-9)
        S = P @ C; h = S[0] + (S[0].std() / (S[1].std() + 1e-9)) * S[1]
        H[n:n + l] += h - h.mean()
    return H

def ring_and_center(frames, r=0.12):
    f = np.asarray(frames, np.float64); S = f.shape[1]; k = max(2, int(S * r))
    ring = np.ones((S, S), bool); ring[k:-k, k:-k] = False
    center = f[:, S // 4: 3 * S // 4, S // 4: 3 * S // 4].reshape(len(f), -1, 3).mean(1)
    return f[:, ring].mean(1), center

def remove_common(x, ref):
    a, b = bandpass(x), bandpass(ref); bb = b @ b
    return a - (a @ b) / bb * b if bb > 1e-12 else a

def rel_amp(x, f0):
    x = bandpass(x / (np.mean(x) + 1e-9)); n = max(8 * len(x), 8192)
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x)), n)); f = np.fft.rfftfreq(n, 1 / FPS)
    return float(spec[np.abs(f - f0) <= 0.05].max())

def flicker_gate(hr_raw, hr_bg, leak_ratio):
    return abs(hr_raw - hr_bg) <= 4 and leak_ratio < 3

def corr(a, b):
    a, b = bandpass(a), bandpass(b)
    return float(abs(np.corrcoef(a, b)[0, 1])) if a.std() > 1e-12 and b.std() > 1e-12 else 0.0

# ---------------------------------------------------------------- video -> face crops (helper process)
def face_clip(video_path, models, workdir):
    out = os.path.join(workdir, 'clip')
    errors = []
    for det in ('yunet', 'haar', 'none'):
        job = {'mode': 'video', 'path': video_path, 'out': out, 'detector': det, 'yunet_path': YUNET,
               'fps': FPS, 'img_size': models.img_size, 'det_every': DET_EVERY, 'max_sec': MAX_SEC,
               'max_side': 960}
        r = subprocess.run([sys.executable, WORKER, json.dumps(job)], capture_output=True, text=True)
        if r.returncode == 0:
            frames = np.load(out + '_frames.npy'); stats = pd.read_csv(out + '_stats.csv')
            return frames, stats, det
        errors.append(f'{det}: {(r.stderr or r.stdout).strip().splitlines()[-1:] or ["?"]}')
    raise RuntimeError('Could not read the video. ' + ' | '.join(errors))

# ---------------------------------------------------------------- features for one 10-second window
def window_features(models, fr, st):
    ring, center = ring_and_center(fr)
    bg = ring[:, 1] / (ring[:, 1].mean() + 1e-9)
    hr_bg, snr_bg, _ = hr_quality(bg)
    face_vs_bg = rel_amp(center[:, 1], hr_bg / 60) / (rel_amp(ring[:, 1], hr_bg / 60) + 1e-12)
    cnn_raw, pos_raw = models.cnn_pulse(fr), pos_signal(center)
    hr_cr, snr_cr, pr_cr = hr_quality(cnn_raw)
    hr_pr, snr_pr, pr_pr = hr_quality(pos_raw)
    flick_c, flick_p = flicker_gate(hr_cr, hr_bg, face_vs_bg), flicker_gate(hr_pr, hr_bg, face_vs_bg)
    hr_cc, snr_c, pr_c = hr_quality(remove_common(cnn_raw, bg)) if flick_c else (hr_cr, snr_cr, pr_cr)
    hr_pc, snr_p, pr_p = hr_quality(remove_common(pos_raw, bg)) if flick_p else (hr_pr, snr_pr, pr_pr)
    side = st.det_side.mean()
    diffs = np.abs(np.diff(fr[::3].astype(np.float32), axis=0)).mean() / (fr.mean() + 1)
    row = {'hr_cnn_raw': hr_cr, 'hr_cnn_clean': hr_cc, 'hr_pos_raw': hr_pr, 'hr_pos_clean': hr_pc, 'hr_bg': hr_bg,
           'snr_cnn': snr_c, 'peak_ratio_cnn': pr_c, 'snr_pos': snr_p, 'peak_ratio_pos': pr_p,
           'hr_disagree': abs(hr_cc - hr_pc),
           'bg_snr': snr_bg, 'bg_match': abs(hr_cr - hr_bg), 'bg_corr': corr(cnn_raw, bg),
           'clean_shift': abs(hr_cc - hr_cr) + abs(hr_pc - hr_pr),
           'flicker_flag': float(flick_c or flick_p), 'face_vs_bg': min(face_vs_bg, 50.0),
           'face_found': st.det_ok[st.det_try].mean(),
           'motion_xy': float(np.hypot(st.det_cx.std(), st.det_cy.std()) / side) if side > 0 else np.nan,
           'motion_scale': float(st.det_side.std() / side) if side > 0 else np.nan,
           'frame_change': float(diffs),
           'light_change': float(st.lum.std() / (st.lum.mean() + 1e-6)),
           'exposure_clip': float(st.clip_frac.mean()),          # only used by older trust models
           'face_brightness': float(center.mean())}             # app rule only, never a model input
    row['hr_app'] = row[ESTIMATES[models.estimate]]
    return row

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
        frames, stats, detector = face_clip(video_path, models, workdir)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    W, S = int(models.win_sec * FPS), STRIDE_SEC * FPS
    if len(frames) < W:
        return {'ok': False, 'message': f'The video is too short. Please record at least {models.win_sec} seconds '
                                         f'(this one is {len(frames) / FPS:.1f} s).'}
    rows = []
    for s in range(0, len(frames) - W + 1, S):
        r = window_features(models, np.asarray(frames[s:s + W]), stats.iloc[s:s + W])
        r['start_s'] = s / FPS; rows.append(r)
    df = pd.DataFrame(rows)
    X = df.reindex(columns=models.features).fillna(models.missing)
    df['p_reliable'] = models.trust['model'].predict_proba(X)[:, 1]
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
                    'device': str(device)},
        'readings': [{'start_s': round(r.start_s, 1), 'hr_bpm': round(r.hr_app, 1),
                      'p_reliable': round(r.p_reliable, 3), 'reliable': bool(r.reliable),
                      'hr_cnn': round(r.hr_cnn_raw, 1), 'hr_pos': round(r.hr_pos_raw, 1),
                      'flicker': bool(r.flicker_flag)} for r in df.itertuples()],
    }
    if not len(acc):
        result['message'] = "We couldn't get a reliable reading from this video."
    return result
