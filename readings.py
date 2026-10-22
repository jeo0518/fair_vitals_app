"""Daily pulse log: save a measured heart rate, list a user's readings, delete one, and judge a reading
against the typical resting range for the user's age.

Typical resting ranges (MedlinePlus, "Pulse", medlineplus.gov/ency/article/003399.htm):
  children 7-9 years: 70-110 BPM; children 10 and older and adults, including seniors: 60-100 BPM;
  well-trained athletes: 40-60 BPM. Accounts start at age 13 (auth.MIN_AGE), so today every user gets
  60-100; the younger band is kept so a lower minimum age would still be judged correctly.
"""
import psycopg
from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from auth import age_from, bad, connect, db_down, json_body, session_user

router = APIRouter(prefix='/api')
MIN_BPM, MAX_BPM = 30, 220          # outside this a saved "reading" can't be a real resting pulse
NEAR = 5                            # within this many BPM of a limit: the camera's typical error, so say so
FAR_LOW, FAR_HIGH = 40, 120         # well outside the range: also say to get checked if it keeps happening
MAX_LIST = 1000                     # readings returned to My page


def typical_range(age):
    """(low, high, who) for a resting heart rate, or None when we have no checked range for this age."""
    if age is None or age >= 10:
        return 60, 100, 'ages 10 and over, including adults and seniors'
    if age >= 7:
        return 70, 110, 'children 7 to 9'
    return None


def assess(bpm, age):
    """How a reading compares with the typical resting range for this age."""
    rng = typical_range(age)
    if rng is None:
        return {'status': 'unknown', 'age': age}
    low, high, who = rng
    status = 'low' if bpm < low else 'high' if bpm > high else 'normal'
    return {'status': status, 'age': age, 'low': low, 'high': high, 'who': who,
            'near_edge': min(abs(bpm - low), abs(bpm - high)) <= NEAR,
            'far': bpm < FAR_LOW or bpm > FAR_HIGH}


def reading_json(row, age):
    rid, bpm, trust, measured_at = row
    return {'id': rid, 'bpm': round(bpm, 1), 'trust': None if trust is None else round(trust, 3),
            'measured_at': measured_at.isoformat(), 'status': assess(bpm, age)['status']}


def _number(value, low, high):
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return x if low <= x <= high else None


@router.post('/readings')
async def save_reading(request: Request):
    body = await json_body(request)
    if body is None:
        return bad('Send the reading as JSON.', 415)
    bpm = _number(body.get('bpm'), MIN_BPM, MAX_BPM)
    if bpm is None:
        return bad(f'A heart rate must be a number from {MIN_BPM} to {MAX_BPM} BPM.')
    trust = _number(body.get('trust'), 0, 1) if body.get('trust') is not None else None

    def work():
        with connect() as conn:
            user = session_user(conn, request)
            if user is None:
                return bad('Please log in to save your readings.', 401)
            age = age_from(user[4])
            row = conn.execute('INSERT INTO readings (user_id, bpm, trust) VALUES (%s, %s, %s) '
                               'RETURNING id, bpm, trust, measured_at', (user[0], bpm, trust)).fetchone()
            return {'ok': True, 'reading': reading_json(row, age), 'assessment': assess(bpm, age)}
    try:
        return await run_in_threadpool(work)
    except psycopg.OperationalError:
        return db_down()


@router.get('/readings')
def list_readings(request: Request):
    try:
        with connect() as conn:
            user = session_user(conn, request)
            if user is None:
                return bad('Please log in to see your readings.', 401)
            age = age_from(user[4])
            rows = conn.execute('SELECT id, bpm, trust, measured_at FROM (SELECT id, bpm, trust, measured_at FROM readings '
                                'WHERE user_id = %s ORDER BY measured_at DESC LIMIT %s) r ORDER BY measured_at',
                                (user[0], MAX_LIST)).fetchall()
    except psycopg.OperationalError:
        return db_down()
    rng = typical_range(age)
    return {'ok': True, 'age': age,
            'range': None if rng is None else {'low': rng[0], 'high': rng[1], 'who': rng[2]},
            'readings': [reading_json(r, age) for r in rows]}


@router.delete('/readings/{reading_id}')
def delete_reading(reading_id: int, request: Request):
    try:
        with connect() as conn:
            user = session_user(conn, request)
            if user is None:
                return bad('Please log in first.', 401)
            gone = conn.execute('DELETE FROM readings WHERE id = %s AND user_id = %s', (reading_id, user[0])).rowcount
    except psycopg.OperationalError:
        return db_down()
    return {'ok': True} if gone else bad('That reading was not found.', 404)
