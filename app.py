"""Fair Vitals test web app.

Run locally:   uvicorn app:app --port 7860
Then open:     http://localhost:7860
"""
import os, tempfile, traceback
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
import pipeline

app = FastAPI(title='Fair Vitals (test)')
HERE = os.path.dirname(os.path.abspath(__file__))
MAX_UPLOAD_MB = 200
models = pipeline.Models()          # loaded once at startup
print(f'Models loaded: {models.cnn_name}, trust {models.trust_file}, estimate "{models.estimate}", threshold {models.threshold}')

@app.get('/')
def index():
    return FileResponse(os.path.join(HERE, 'static', 'index.html'))

@app.get('/health')
def health():
    return {'ok': True, 'cnn': models.cnn_name, 'estimate': models.estimate}

@app.post('/analyze')
async def analyze(video: UploadFile = File(...)):
    suffix = os.path.splitext(video.filename or '')[1] or '.mp4'
    fd, path = tempfile.mkstemp(suffix=suffix); size = 0
    try:
        with os.fdopen(fd, 'wb') as fh:
            while chunk := await video.read(1 << 20):
                size += len(chunk)
                if size > MAX_UPLOAD_MB << 20:
                    return JSONResponse({'ok': False, 'message': f'Video is larger than {MAX_UPLOAD_MB} MB.'}, 413)
                fh.write(chunk)
        return pipeline.analyze(path, models)
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({'ok': False, 'message': f'Analysis failed: {e}'}, 500)
    finally:
        os.remove(path)            # the video is deleted right after analysis
