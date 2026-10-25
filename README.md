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
- `static/js/intro.js`: the first-visit intro (warp flight to a beating heart planet). Plays once per browser; add `?intro` to the address to see it again.
- `static/js/measure.js`: uploading a video, showing the result, and saving it (home page: the page turns to the verdict and advice).
- `static/my.html`, `static/js/my.js`: My page (log in, create an account, your age, the pulse log chart and daily list).
- `auth.py`: accounts and logins (with age), stored in PostgreSQL.
- `readings.py`: the daily pulse log (save, list, delete readings) and the check against the typical resting
  range for the user's age (MedlinePlus ranges).
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

### Accounts database (PostgreSQL)
My page needs a PostgreSQL database; the rest of the site works without one. One-time setup:

    psql --version                     # check PostgreSQL is installed
    brew services start postgresql@16  # start it (or open Postgres.app); use your installed version number
    createdb fairvitals                # make the database

The app connects to `postgresql:///fairvitals` (this computer, your Mac user, database `fairvitals`) and
creates its tables on first use. To use another database, set `DATABASE_URL` before starting, e.g.
`export DATABASE_URL=postgresql://user:password@host:5432/dbname`. On a host that serves the site over
HTTPS, also set `FV_SECURE_COOKIE=1`.

## Test videos
`tests/` has a set of synthetic test videos with a known heart rate and known problems (too short, no face,
too dark, backlit, flickering light at 125 BPM, a shaky camera, a phone video stored sideways, an iPhone-style
HEVC .mov, a large 4K 60 fps file, and a text file pretending to be a video), plus a script that sends each
one to a running Fair Vitals and checks the result:

    python tests/make_videos.py                                   # once, takes about 15 minutes
    python tests/check_videos.py                                  # checks http://localhost:7860
    python tests/check_videos.py --url https://YOUR-SPACE.hf.space

They check that the app behaves sensibly, not how accurate it is: a still photo with a clean, made-up pulse
is far easier than real skin. The face is NASA's public-domain portrait of astronaut Eileen Collins.

## Deploy on Hugging Face Spaces (free, permanent link)
1. Create a new Space, choose **Docker** as the SDK.
2. Upload all files in this folder, including `models/` with the two model files.
3. Set the scikit-learn version in `requirements.txt` to the one in Colab first.
4. Wait for the build; the Space URL is your app.
