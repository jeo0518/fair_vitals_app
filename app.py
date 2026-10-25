"""Fair Vitals test web app.

Run locally:   uvicorn app:app --port 7860
Then open:     http://localhost:7860
"""
import os, tempfile, traceback


def cpu_limit():
    """CPUs this container may actually use. On shared hosts (e.g. Hugging Face Spaces) os.cpu_count()
    reports the whole machine, and running that many threads on a 2-CPU allowance slows analysis to a crawl."""
    try:
        quota, period = open('/sys/fs/cgroup/cpu.max').read().split()            # cgroup v2
        if quota != 'max':
            return max(1, int(int(quota) / int(period)))
    except (OSError, ValueError):
        pass
    try:
        quota = int(open('/sys/fs/cgroup/cpu/cpu.cfs_quota_us').read())          # cgroup v1
        period = int(open('/sys/fs/cgroup/cpu/cpu.cfs_period_us').read())
        if quota > 0:
            return max(1, quota // period)
    except (OSError, ValueError):
        pass
    try:
        return len(os.sched_getaffinity(0))
    except AttributeError:                                                        # macOS
        return os.cpu_count() or 1


# set before torch/numpy/OpenCV load; the video helper process inherits these too
THREADS = str(min(cpu_limit(), 8))
for var in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'FV_THREADS'):
    os.environ.setdefault(var, THREADS)

from fastapi import FastAPI, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
import torch
import pipeline, auth, readings

torch.set_num_threads(int(os.environ['OMP_NUM_THREADS']))
print(f'Using {torch.get_num_threads()} CPU thread(s)')

app = FastAPI(title='Fair Vitals (test)')
HERE = os.path.dirname(os.path.abspath(__file__))
MAX_UPLOAD_MB = 200
models = pipeline.Models()          # loaded once at startup
print(f'Models loaded: {models.cnn_name}, trust {models.trust_file}, estimate "{models.estimate}", threshold {models.threshold}')
app.mount('/source', StaticFiles(directory=os.path.join(HERE, 'static', 'source')), name='source')
app.mount('/static', StaticFiles(directory=os.path.join(HERE, 'static')), name='static')
app.include_router(auth.router)
app.include_router(readings.router)

@app.get('/')
def index():
    return FileResponse(os.path.join(HERE, 'static', 'index.html'))

@app.get('/about')
def about():
    return FileResponse(os.path.join(HERE, 'static', 'about.html'))

@app.get('/my')
def my_page():
    return FileResponse(os.path.join(HERE, 'static', 'my.html'))

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
        print(f'Analyzing {size / 2**20:.1f} MB video', flush=True)
        # in a worker thread, so the server keeps answering other requests during a long analysis
        return await run_in_threadpool(pipeline.analyze, path, models)
    except pipeline.VideoError as e:
        return JSONResponse({'ok': False, 'message': str(e)}, 400)
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({'ok': False, 'message': 'Something went wrong while analyzing the video. Please try again.'}, 500)
    finally:
        os.remove(path)            # the video is deleted right after analysis
