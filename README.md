---
title: Fair Vitals Test
sdk: docker
app_port: 7860
---

# Fair Vitals: test web app

Upload a selfie video and get a heart rate plus a trust score, using the Fair Vitals models.
The pipeline (`pipeline.py`) mirrors `fair_vitals_trust_score.ipynb` exactly: same face crops,
same 17 trust features, same heart-rate estimate.

## Files
- `app.py`: web server (FastAPI). `POST /analyze` takes a video, returns JSON. The video is deleted after analysis.
- `pipeline.py`: video, then 10-second readings, then heart rate + trust score + tips.
- `fair_vitals_core.py`: models, readings and trust features, copied unchanged from Drive (`congressional-app-challenge/`).
  If you change it on Drive, copy it here again so the app matches the notebooks.
- `worker.py`: decodes the video (ffmpeg) and crops the face (YuNet) in a separate process.
- `static/index.html`: the home page (short explanation + the video upload).
- `static/about.html`: the about page (architecture, what's new, limitations).
- `static/css/site.css`, `static/js/site.js`: the shared look and effects of every page.
- `static/js/measure.js`: uploading a video and showing the result (home page).
- `models/`: put the model files here (see below).

## Models to copy from Google Drive (`congressional-app-challenge/models/`)
1. `trust_model_refiner.joblib`
2. `pos_refiner.pt` (the POS-refiner: the heart rate the app shows)
3. `stage2_ucla_best.pt` (the Stage 2 CNN: the trust model uses its reading as a second opinion)
The YuNet face model downloads automatically on first start.

## Run on your Mac
    brew install ffmpeg
    pip install -r requirements.txt
    uvicorn app:app --port 7860
Open http://localhost:7860

## Deploy on Hugging Face Spaces (free, permanent link)
1. Create a new Space, choose **Docker** as the SDK.
2. Upload all files in this folder, including `models/` with the two model files.
3. Set the scikit-learn version in `requirements.txt` to the one in Colab first.
4. Wait for the build; the Space URL is your app.
