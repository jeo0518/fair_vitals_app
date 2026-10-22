"""
Fair Vitals core: everything analyze() needs, copied from the notebooks the models were trained with.

    crop_video(path)        -> face crops (T, 64, 64, 3) + per-frame detection stats      [trust notebook, section 2]
    crop_frames(frames)     -> same, for raw frames already in memory (e.g. from the web UI)
    flicker_check(...)      -> is this window's rhythm really background flicker?          [trust notebook, section 4]
    remove_common(x, ref)   -> subtract the part of a pulse that moves with the background
    window_features(...)    -> the trust model's inputs for one 10 s window                 [trust notebook, section 4]
    refiner_hr(...)         -> heart rate from the POS-refiner                              [refiner notebook, sections 3-4]
    trust_score(feats)      -> 0-1 chance the reading is within 5 BPM                      [trust notebook, section 5]
    analyze(...)            -> heart rate, trust, status (same output shape as Stage 5)

Rules that must not change, or the models see different inputs than they were trained on:
  * Crops are the FACE PLUS A BORDER: a square 1.5x the face box, resized to 64x64. The outer 12% is the
    "background" (flicker detection, background features, refiner input); the central half is the "face".
  * 30 fps, 10-second windows, a new window every 5 seconds.
  * The Stage 2 CNN runs on every window: the trust model uses its reading as a second opinion.

Usage:
    import fair_vitals_core as fv
    models = fv.load_models('/content/drive/MyDrive/congressional-app-challenge/models')
    result = fv.analyze_video('selfie.mp4', models)          # from a video file
    result = fv.analyze(raw_frames, models)                   # from raw RGB frames (T, H, W, 3), 30 fps
    result = fv.analyze(crops, models, stats=stats)           # from crops you already made with crop_*()
"""
import json
import os
import subprocess
import urllib.request

import numpy as np
import pandas as pd
from scipy.signal import butter, filtfilt, find_peaks

FPS = 30
WIN_SEC, STRIDE_SEC = 10, 5
IMG_SIZE = 64                  # Stage 2 CNN input size; the trust model and refiner were built on these crops
DET_EVERY = 6                  # face detection 5 times per second
RING_FRAC = 0.12               # outer 12% of the crop = background
LO, HI = 0.7, 3.0              # heart-rate band, Hz (42-180 BPM)
YUNET_URL = ('https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/'
             'face_detection_yunet/face_detection_yunet_2023mar.onnx')


# ----------------------------------------------------------------------------------------------------------
# 1. Face cropping (identical to the trust notebook's video worker)
# ----------------------------------------------------------------------------------------------------------
class FaceCropper:
    """Finds the face every DET_EVERY frames and crops a smoothly moving square around it.
    Feed frames one at a time with add(); call result() at the end."""

    def __init__(self, yunet_path=None, size=IMG_SIZE):
        import cv2
        self.cv2, self.size = cv2, size
        self.kind = 'none'
        if yunet_path and os.path.exists(yunet_path):
            try:
                self.det = cv2.FaceDetectorYN.create(yunet_path, '', (320, 320), 0.6); self.kind = 'yunet'
            except Exception:
                pass
        if self.kind == 'none':
            self.det = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
            self.kind = 'haar'
        self.recent, self.rows, self.crops, self.k = [], [], [], 0

    def _detect(self, rgb):
        cv2 = self.cv2; h, w, _ = rgb.shape
        s = 480 / max(h, w) if max(h, w) > 480 else 1.0
        small = cv2.resize(rgb, (int(w * s), int(h * s))) if s < 1 else np.ascontiguousarray(rgb)
        if self.kind == 'yunet':
            self.det.setInputSize((small.shape[1], small.shape[0]))
            _, faces = self.det.detect(cv2.cvtColor(small, cv2.COLOR_RGB2BGR))
            if faces is None or len(faces) == 0:
                return None
            x, y, fw, fh = max(faces[:, :4].tolist(), key=lambda f: f[2] * f[3])
        else:
            faces = self.det.detectMultiScale(cv2.cvtColor(small, cv2.COLOR_RGB2GRAY), 1.1, 5, minSize=(40, 40))
            if len(faces) == 0:
                return None
            x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
        return ((x + fw / 2) / s, (y + fh / 2) / s, max(fw, fh) / s)

    def add(self, rgb):
        rgb = np.asarray(rgb, np.uint8); h, w, _ = rgb.shape; k = self.k
        det = self._detect(rgb) if k % DET_EVERY == 0 else None
        if det:
            self.recent = (self.recent + [det])[-10:]               # last 2 s of detections
        if self.recent:
            cx, cy, side = np.median(np.array(self.recent), axis=0)
        else:                                                      # no face yet: centre of the frame
            cx, cy, side = w / 2, h / 2, 0.6 * min(h, w) / 1.5
        s = int(min(side * 1.5, h, w))
        x1 = int(np.clip(cx - s / 2, 0, w - s)); y1 = int(np.clip(cy - s / 2, 0, h - s))
        crop = self.cv2.resize(np.ascontiguousarray(rgb[y1:y1 + s, x1:x1 + s]), (self.size, self.size),
                               interpolation=self.cv2.INTER_AREA)
        g = crop.mean(-1)
        clip = float(((crop > 250).any(-1) | (crop < 5).all(-1)).mean())
        self.rows.append([k % DET_EVERY == 0, det is not None,
                          det[0] / w if det else np.nan, det[1] / h if det else np.nan,
                          det[2] / min(h, w) if det else np.nan, float(g.mean()), clip])
        self.crops.append(crop); self.k += 1

    def result(self):
        stats = pd.DataFrame(self.rows, columns=['det_try', 'det_ok', 'det_cx', 'det_cy', 'det_side', 'lum', 'clip_frac'])
        crops = np.stack(self.crops) if self.crops else np.zeros((0, self.size, self.size, 3), np.uint8)
        return crops, stats


def get_yunet(path='/tmp/face_detection_yunet_2023mar.onnx'):
    """Download OpenCV's YuNet face detector once. Returns its path, or None (then Haar is used)."""
    try:
        if not os.path.exists(path) or os.path.getsize(path) < 100_000:
            urllib.request.urlretrieve(YUNET_URL, path)
        return path
    except Exception:
        return None


def crop_frames(frames, yunet_path=None):
    """Raw RGB frames (T, H, W, 3) at 30 fps -> crops (T, 64, 64, 3) uint8 and per-frame stats."""
    fc = FaceCropper(yunet_path)
    for fr in frames:
        fc.add(fr)
    return fc.result()


def crop_video(path, yunet_path=None, max_sec=180):
    """Video file -> crops (T, 64, 64, 3) and stats. Decodes with ffmpeg at 30 fps, like the training data.
    Phone videos with rotation metadata are rotated upright by ffmpeg automatically."""
    pr = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                         'stream=width,height:stream_side_data=rotation:stream_tags=rotate', '-of', 'json', path],
                        capture_output=True, text=True)
    if pr.returncode != 0:
        raise ValueError(f'Could not read video: {pr.stderr[:200]}')
    st = json.loads(pr.stdout)['streams'][0]
    w, h = int(st['width']), int(st['height'])
    rot = st.get('tags', {}).get('rotate') or next((d.get('rotation') for d in st.get('side_data_list', [])
                                                    if 'rotation' in d), 0)
    if abs(int(float(rot or 0))) % 180 == 90:
        w, h = h, w
    proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-nostdin', '-i', path, '-t', str(max_sec),
                             '-vf', f'fps={FPS}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=10 ** 8)
    fc, nbytes = FaceCropper(yunet_path), w * h * 3
    while True:
        buf = proc.stdout.read(nbytes)
        if len(buf) < nbytes:
            break
        fc.add(np.frombuffer(buf, np.uint8).reshape(h, w, 3))
    proc.stdout.close(); proc.wait()
    return fc.result()


# ----------------------------------------------------------------------------------------------------------
# 2. Signal tools (trust notebook, section 4)
# ----------------------------------------------------------------------------------------------------------
def bandpass(x, lo=LO, hi=HI, order=2):
    b, a = butter(order, [lo / (FPS / 2), hi / (FPS / 2)], btype='band')
    return filtfilt(b, a, np.asarray(x, dtype=np.float64))


def hr_quality(x):
    """Heart rate (BPM), SNR (dB) and peak ratio of a pulse signal."""
    x = bandpass(x); n = max(8 * len(x), 8192)
    p = np.abs(np.fft.rfft((x - x.mean()) * np.hanning(len(x)), n)) ** 2
    f = np.fft.rfftfreq(n, 1 / FPS); band = (f >= LO) & (f <= 4.0); f, p = f[band], p[band]
    inb = f <= HI
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


def ring_and_center(frames, r=RING_FRAC):
    """Mean colour per frame of the crop's border (background) and of its central half (face)."""
    f = np.asarray(frames, np.float64); S = f.shape[1]; k = max(2, int(S * r))
    ring = np.ones((S, S), bool); ring[k:-k, k:-k] = False
    center = f[:, S // 4: 3 * S // 4, S // 4: 3 * S // 4].reshape(len(f), -1, 3).mean(1)
    return f[:, ring].mean(1), center


def remove_common(x, ref):
    """Flicker correction: remove the part of pulse x that moves together with the background signal ref."""
    a, b = bandpass(x), bandpass(ref); bb = b @ b
    return a - (a @ b) / bb * b if bb > 1e-12 else a


def rel_amp(x, f0):
    x = bandpass(x / (np.mean(x) + 1e-9)); n = max(8 * len(x), 8192)
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x)), n)); f = np.fft.rfftfreq(n, 1 / FPS)
    return float(spec[np.abs(f - f0) <= 0.05].max())


def flicker_check(hr_raw, hr_bg, face_vs_bg):
    """True if a reading is probably light flicker: it matches the background's rhythm AND that rhythm is about
    as strong in the background as on the face (a real pulse is much stronger on the face)."""
    return abs(hr_raw - hr_bg) <= 4 and face_vs_bg < 3


def background(ring, center):
    """Background signal, its heart-rate-band rhythm, and how much stronger that rhythm is on the face."""
    bg = ring[:, 1] / (ring[:, 1].mean() + 1e-9)
    hr_bg, snr_bg, _ = hr_quality(bg)
    face_vs_bg = rel_amp(center[:, 1], hr_bg / 60) / (rel_amp(ring[:, 1], hr_bg / 60) + 1e-12)
    return bg, hr_bg, snr_bg, face_vs_bg


def flicker_corrected_hr(pulse, ring, center):
    """Heart rate of a pulse signal after flicker correction (applied only when flicker is detected)."""
    bg, hr_bg, _, face_vs_bg = background(ring, center)
    hr, snr, pr = hr_quality(pulse)
    if flicker_check(hr, hr_bg, face_vs_bg):
        return hr_quality(remove_common(pulse, bg)) + (True,)
    return hr, snr, pr, False


def corr(a, b):
    a, b = bandpass(a), bandpass(b)
    return float(abs(np.corrcoef(a, b)[0, 1])) if a.std() > 1e-12 and b.std() > 1e-12 else 0.0


# ----------------------------------------------------------------------------------------------------------
# 3. Models: Stage 2 CNN, POS-refiner, trust model
# ----------------------------------------------------------------------------------------------------------
def _torch_models():
    import torch.nn as nn
    import torch

    class PulseModel(nn.Module):                       # friend's Stage 1 architecture (Stage 2 was built on it)
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

    def conv_bn(cin, cout, k=(3, 3, 3)):
        return nn.Sequential(nn.Conv3d(cin, cout, k, padding=tuple(s // 2 for s in k), bias=False),
                             nn.BatchNorm3d(cout), nn.ReLU(inplace=True))

    class PhysNet3D(nn.Module):
        def __init__(self, width=32, dropout=0.2):
            super().__init__(); w = width
            self.features = nn.Sequential(
                conv_bn(3, w // 2, (1, 5, 5)), nn.MaxPool3d((1, 2, 2)),
                conv_bn(w // 2, w), conv_bn(w, w), nn.MaxPool3d((1, 2, 2)),
                conv_bn(w, 2 * w), conv_bn(2 * w, 2 * w), nn.MaxPool3d((1, 2, 2)),
                conv_bn(2 * w, 2 * w), conv_bn(2 * w, 2 * w), nn.AdaptiveAvgPool3d((None, 1, 1)))
            self.head = nn.Sequential(nn.Conv1d(2 * w, 2 * w, 5, padding=2), nn.BatchNorm1d(2 * w),
                                      nn.ReLU(inplace=True), nn.Dropout(dropout), nn.Conv1d(2 * w, 1, 1))

        def forward(self, x):
            return self.head(self.features(x).flatten(2)).squeeze(1)

    class Block(nn.Module):
        def __init__(self, ch, d):
            super().__init__()
            self.net = nn.Sequential(nn.Conv1d(ch, ch, 5, padding=2 * d, dilation=d), nn.BatchNorm1d(ch), nn.GELU(),
                                     nn.Dropout(0.1), nn.Conv1d(ch, ch, 1))

        def forward(self, x):
            return x + self.net(x)

    class Refiner(nn.Module):                          # POS-refiner (refiner notebook, section 4)
        def __init__(self, cin=8, ch=48):
            super().__init__()
            self.inp = nn.Conv1d(cin, ch, 1)
            self.blocks = nn.Sequential(*[Block(ch, d) for d in (1, 2, 4, 8, 16, 1)])
            self.out = nn.Conv1d(ch, 1, 1)
            nn.init.zeros_(self.out.weight); nn.init.zeros_(self.out.bias)

        def forward(self, x):
            return x[:, 6] + self.out(self.blocks(self.inp(x))).squeeze(1)

    return PulseModel, PhysNet3D, Refiner


def prep_stage1(frames):
    f = frames.astype(np.float32) / 255.0
    f = f - f.mean(axis=0); return f / (f.std() + 1e-6)


def prep_physnet(frames):
    f = frames.astype(np.float32) / 255.0 + 1e-3
    d = (f[1:] - f[:-1]) / (f[1:] + f[:-1]); d = d / (d.std() + 1e-8)
    return np.concatenate([d, np.zeros_like(d[:1])], axis=0)


class Models:
    """Everything loaded once: CNN, refiner, trust model. Build with load_models()."""
    pass


def load_models(model_dir, trust_file=None, device=None, yunet_path='auto'):
    """Loads stage2_ucla_best.pt, pos_refiner.pt and the trust model from model_dir.
    trust_file defaults to trust_model_refiner.joblib (trust retrained on refiner readings) if it exists,
    otherwise trust_model.joblib (the original, trained on flicker-corrected POS readings)."""
    import torch
    import joblib
    PulseModel, PhysNet3D, Refiner = _torch_models()
    m = Models()
    m.torch = torch
    m.device = torch.device(device or ('cuda' if torch.cuda.is_available() else 'cpu'))

    ck = torch.load(f'{model_dir}/stage2_ucla_best.pt', map_location=m.device, weights_only=False)
    m.cnn_base = ck['base']
    if ck['img_size'] != IMG_SIZE:
        raise ValueError(f"CNN expects {ck['img_size']}px crops; this module crops to {IMG_SIZE}px")
    m.cnn = (PulseModel() if m.cnn_base == 'stage1' else PhysNet3D()).to(m.device)
    m.cnn.load_state_dict(ck['model']); m.cnn.eval()
    m.prep = prep_stage1 if m.cnn_base == 'stage1' else prep_physnet
    m.to_pulse = (lambda o: o) if m.cnn_base == 'stage1' else np.cumsum

    rk = torch.load(f'{model_dir}/pos_refiner.pt', map_location=m.device, weights_only=False)
    m.refiner = Refiner().to(m.device); m.refiner.load_state_dict(rk['model']); m.refiner.eval()

    if trust_file is None:
        trust_file = 'trust_model_refiner.joblib' if os.path.exists(f'{model_dir}/trust_model_refiner.joblib') \
            else 'trust_model.joblib'
    t = joblib.load(f'{model_dir}/{trust_file}')
    m.trust, m.features, m.threshold = t['model'], t['features'], float(t['threshold'])
    m.missing, m.trust_estimate, m.trust_file = t.get('missing_value', -1.0), t.get('estimate', '?'), trust_file
    m.yunet = get_yunet() if yunet_path == 'auto' else yunet_path
    return m


# ----------------------------------------------------------------------------------------------------------
# 4. Per-window readings and features
# ----------------------------------------------------------------------------------------------------------
def cnn_pulse(models, frames):
    torch = models.torch
    x = torch.from_numpy(np.ascontiguousarray(models.prep(frames).transpose(3, 0, 1, 2)))[None].to(models.device)
    with torch.no_grad(), torch.autocast(device_type=models.device.type, enabled=models.device.type == 'cuda'):
        return models.to_pulse(models.cnn(x).float().cpu().numpy()[0])


def _pos_torch(torch, rgb, win=int(1.6 * FPS)):
    B, T, _ = rgb.shape
    if T < win:
        return torch.zeros(B, T, device=rgb.device)
    C = rgb.unfold(1, win, 1)
    C = C / (C.mean(-1, keepdim=True) + 1e-9)
    S0 = C[:, :, 1] - C[:, :, 2]; S1 = -2 * C[:, :, 0] + C[:, :, 1] + C[:, :, 2]
    h = S0 + (S0.std(-1, keepdim=True) / (S1.std(-1, keepdim=True) + 1e-9)) * S1
    h = h - h.mean(-1, keepdim=True)
    H = torch.zeros(B, T, device=rgb.device); n = h.shape[1]
    for k in range(win):
        H[:, k:k + n] += h[:, :, k]
    return H


def _fft_bandpass(torch, x, lo=0.6, hi=4.0):
    X = torch.fft.rfft(x, dim=-1); f = torch.fft.rfftfreq(x.shape[-1], 1 / FPS).to(x.device)
    X[..., (f < lo) | (f > hi)] = 0
    return torch.fft.irfft(X, n=x.shape[-1], dim=-1)


def refiner_input(torch, center, ring):
    """(B, T, 3) face-centre and border colour -> (B, 8, T) refiner input (refiner notebook, section 3)."""
    cn = center / (center.mean(1, keepdim=True) + 1e-9) - 1
    rn = ring / (ring.mean(1, keepdim=True) + 1e-9) - 1
    col = _fft_bandpass(torch, torch.cat([cn, rn], -1).transpose(1, 2))
    col = col / (col[:, 1:2].std(-1, keepdim=True) + 1e-9)
    pc = _fft_bandpass(torch, _pos_torch(torch, center)); pr = _fft_bandpass(torch, _pos_torch(torch, ring))
    z = lambda x: (x - x.mean(-1, keepdim=True)) / (x.std(-1, keepdim=True) + 1e-9)
    return torch.cat([col, z(pc)[:, None], z(pr)[:, None]], 1)


def refiner_pulse(models, center, ring):
    """Cleaned pulse wave for one window from the refiner. center, ring: (T, 3) mean colour per frame."""
    torch = models.torch
    t = lambda a: torch.tensor(np.asarray(a, np.float32)[None], device=models.device)
    with torch.no_grad():
        return models.refiner(refiner_input(torch, t(center), t(ring))).cpu().numpy()[0]


def refiner_hr(models, center, ring):
    hr, snr, pr = hr_quality(refiner_pulse(models, center, ring))
    return hr, snr


def window_features(models, crops, stats):
    """All readings and trust-model inputs for one 10 s window of crops (300, 64, 64, 3) and its stats rows.
    Feature definitions are copied from the trust notebook's window_rows()."""
    fr = np.asarray(crops); st = stats.reset_index(drop=True)
    ring, center = ring_and_center(fr)
    bg, hr_bg, snr_bg, face_vs_bg = background(ring, center)
    cnn_raw, pos_raw = cnn_pulse(models, fr), pos_signal(center)
    hr_cr, snr_cr, pr_cr = hr_quality(cnn_raw)
    hr_pr, snr_pr, pr_pr = hr_quality(pos_raw)
    flick_c, flick_p = flicker_check(hr_cr, hr_bg, face_vs_bg), flicker_check(hr_pr, hr_bg, face_vs_bg)
    hr_cc, snr_c, pr_c = hr_quality(remove_common(cnn_raw, bg)) if flick_c else (hr_cr, snr_cr, pr_cr)
    hr_pc, snr_p, pr_p = hr_quality(remove_common(pos_raw, bg)) if flick_p else (hr_pr, snr_pr, pr_pr)
    hr_ref, snr_ref = refiner_hr(models, center.astype(np.float32), ring.astype(np.float32))
    side = st.det_side.mean()
    diffs = np.abs(np.diff(fr[::3].astype(np.float32), axis=0)).mean() / (fr.mean() + 1)
    tried = st.det_try.astype(bool)
    f = {'hr_cnn_raw': hr_cr, 'hr_cnn_clean': hr_cc, 'hr_pos_raw': hr_pr, 'hr_pos_clean': hr_pc,
         'hr_refiner': hr_ref, 'snr_refiner': snr_ref, 'hr_bg': hr_bg,
         'snr_cnn': snr_c, 'peak_ratio_cnn': pr_c, 'snr_pos': snr_p, 'peak_ratio_pos': pr_p,
         'hr_disagree': abs(hr_cc - hr_pc),
         'bg_snr': snr_bg, 'bg_match': abs(hr_cr - hr_bg), 'bg_corr': corr(cnn_raw, bg),
         'clean_shift': abs(hr_cc - hr_cr) + abs(hr_pc - hr_pr),
         'flicker_flag': float(flick_c or flick_p), 'face_vs_bg': min(face_vs_bg, 50.0),
         'face_found': float(st.det_ok[tried].astype(float).mean()) if tried.any() else 0.0,
         'motion_xy': float(np.hypot(st.det_cx.std(), st.det_cy.std()) / side) if side > 0 else np.nan,
         'motion_scale': float(st.det_side.std() / side) if side > 0 else np.nan,
         'frame_change': float(diffs),
         'light_change': float(st.lum.std() / (st.lum.mean() + 1e-6)),
         'ref_vs_pos': abs(hr_ref - hr_pc)}
    # hr_app is "the reading the app shows" - whichever estimate the loaded trust model was trained to judge
    f['hr_app'] = hr_ref if models.trust_estimate == 'Refiner' else hr_pc
    return f


def trust_score(models, feats):
    """Chance (0-1) that this window's reading is within 5 BPM of the truth."""
    x = pd.DataFrame([[feats.get(k, np.nan) for k in models.features]], columns=models.features).fillna(models.missing)
    return float(models.trust.predict_proba(x)[0, 1])


# ----------------------------------------------------------------------------------------------------------
# 5. analyze(): same output as the Stage 5 notebook
# ----------------------------------------------------------------------------------------------------------
def analyze(frames, models, stats=None, low_confidence=0.5):
    """frames: raw RGB frames (T, H, W, 3) at 30 fps, OR 64x64 crops from crop_*() together with their `stats`.
    Returns heart_rate, trust, status, windows, history (refiner heart rate of every 10 s window, every 5 s).
    Status: 'ok' if trust >= the trust model's calibrated threshold; 'low confidence' if trust >= low_confidence;
    otherwise 'unreliable - please retake'."""
    frames = np.asarray(frames)
    if stats is None:
        frames, stats = crop_frames(frames, models.yunet)
    elif frames.shape[1:3] != (IMG_SIZE, IMG_SIZE):
        raise ValueError(f'With stats, frames must be {IMG_SIZE}x{IMG_SIZE} crops from crop_frames()/crop_video()')
    win, step = WIN_SEC * FPS, STRIDE_SEC * FPS
    if len(frames) < win:
        return {'heart_rate': None, 'trust': 0.0, 'status': f'need at least {WIN_SEC} s of video'}
    hrs = []
    for s in range(0, len(frames) - win + 1, step):
        ring, center = ring_and_center(frames[s:s + win])
        hrs.append(refiner_hr(models, center.astype(np.float32), ring.astype(np.float32))[0])
    s = (len(frames) - win) // step * step                       # latest window: full features + trust
    feats = window_features(models, frames[s:s + win], stats.iloc[s:s + win])
    trust = trust_score(models, feats)
    status = 'ok' if trust >= models.threshold else 'low confidence' if trust >= low_confidence \
        else 'unreliable - please retake'
    if feats['face_found'] < 0.5:
        status = 'unreliable - please retake'                     # no face for most of the window
    return {'heart_rate': round(float(hrs[-1]), 1), 'trust': round(trust, 2), 'status': status,
            'windows': len(hrs), 'history': [round(float(x), 1) for x in hrs],
            'face_found': round(feats['face_found'], 2), 'flicker': bool(feats['flicker_flag'])}


def analyze_video(path, models, max_sec=180, **kw):
    crops, stats = crop_video(path, models.yunet, max_sec=max_sec)
    return analyze(crops, models, stats=stats, **kw)
