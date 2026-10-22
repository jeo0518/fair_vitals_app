"""Accounts for Fair Vitals: sign up, log in, log out, "who am I", stored in PostgreSQL.

Database: DATABASE_URL (default postgresql:///fairvitals, i.e. the local server, your own user, database
"fairvitals"). The tables are created on first use. If the database can't be reached, the rest of the app
keeps working and these endpoints answer 503.

Passwords are hashed with scrypt (Python standard library) and never stored. A login creates a random
session token: the browser keeps it in an HttpOnly cookie, the database keeps only its SHA-256 hash.
Endpoints take JSON bodies only, which (with the SameSite=Lax cookie) keeps other sites from posting
forms to them on a user's behalf.
"""
import hashlib, hmac, os, re, secrets, threading, time
from datetime import datetime, timedelta, timezone

import psycopg
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

DATABASE_URL = os.environ.get('DATABASE_URL', 'postgresql:///fairvitals')
SECURE_COOKIE = os.environ.get('FV_SECURE_COOKIE') == '1'   # set on a host that serves HTTPS through a proxy
COOKIE = 'fv_session'
SESSION_DAYS = 30
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2 ** 15, 8, 1           # ~32 MB and ~0.1 s per hash
MAX_FAILS, FAIL_WINDOW = 10, 15 * 60                   # failed logins per IP+email before a 15-minute pause
EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
MIN_AGE, MAX_AGE = 13, 120     # 13: the usual minimum for online accounts (children's privacy laws)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));
CREATE TABLE IF NOT EXISTS sessions (
    token_hash  BYTEA PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
-- age is asked as a number and kept as a birth year, so it stays right in later years (to within a year)
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_year INT;
CREATE TABLE IF NOT EXISTS readings (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    bpm          REAL NOT NULL,
    trust        REAL,
    measured_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS readings_user_time_idx ON readings (user_id, measured_at);
"""

router = APIRouter(prefix='/api')
_schema_ready, _schema_lock = False, threading.Lock()
_fails, _fails_lock = {}, threading.Lock()


# ---------------------------------------------------------------- database
def connect():
    """New connection, with the tables created on first use. Raises psycopg.OperationalError if unreachable."""
    global _schema_ready
    conn = psycopg.connect(DATABASE_URL, connect_timeout=5)
    if not _schema_ready:
        with _schema_lock:
            if not _schema_ready:
                with conn.transaction():
                    conn.execute(SCHEMA)
                _schema_ready = True
    return conn


def db_down():
    return JSONResponse({'ok': False, 'message': 'The account database is not available right now.'}, 503)


# ---------------------------------------------------------------- passwords and tokens
def hash_password(password):
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, maxmem=64 * 2 ** 20)
    return f'scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${h.hex()}'


def check_password(password, stored):
    try:
        _, n, r, p, salt, h = stored.split('$')
        got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p),
                             maxmem=64 * 2 ** 20)
        return hmac.compare_digest(got.hex(), h)
    except ValueError:
        return False


# checked when the email doesn't exist, so a wrong email takes as long as a wrong password
_DUMMY_HASH = hash_password(secrets.token_hex(16))


def token_hash(token):
    return hashlib.sha256(token.encode()).digest()


def start_session(conn, user_id, request, response):
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    conn.execute('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (%s, %s, %s)',
                 (token_hash(token), user_id, expires))
    response.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite='lax',
                        secure=SECURE_COOKIE or request.url.scheme == 'https', path='/')


USER_COLUMNS = 'u.id, u.email, u.name, u.created_at, u.birth_year'


def age_from(birth_year):
    return None if birth_year is None else datetime.now().year - birth_year


def user_json(row):
    """A users row (USER_COLUMNS) as the dict the pages get: no id, age instead of birth year."""
    _, email, name, created_at, birth_year = row
    return {'email': email, 'name': name, 'member_since': created_at.date().isoformat(), 'age': age_from(birth_year)}


def user_by_id(conn, user_id):
    return user_json(conn.execute(f'SELECT {USER_COLUMNS} FROM users u WHERE u.id = %s', (user_id,)).fetchone())


def session_user(conn, request):
    """The logged-in user's row (USER_COLUMNS), or None."""
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    return conn.execute(f"""SELECT {USER_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id
                           WHERE s.token_hash = %s AND s.expires_at > now()""", (token_hash(token),)).fetchone()


def current_user(conn, request):
    """The logged-in user as the pages see it, or None."""
    row = session_user(conn, request)
    return None if row is None else user_json(row)


def parse_age(value):
    """(age, None) or (None, error message)."""
    try:
        age = int(str(value).strip())
    except ValueError:
        return None, 'Please enter your age as a number.'
    if not MIN_AGE <= age <= MAX_AGE:
        return None, f'Accounts are for ages {MIN_AGE} and over. Please enter an age from {MIN_AGE} to {MAX_AGE}.'
    return age, None


# ---------------------------------------------------------------- input
async def json_body(request):
    """The request's JSON object, or None if it isn't JSON (forms from other sites can't send JSON)."""
    if not request.headers.get('content-type', '').startswith('application/json'):
        return None
    try:
        body = await request.json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


def bad(message, status=400):
    return JSONResponse({'ok': False, 'message': message}, status)


def too_many(key):
    now = time.monotonic()
    with _fails_lock:
        recent = [t for t in _fails.get(key, []) if now - t < FAIL_WINDOW]
        _fails[key] = recent
        return len(recent) >= MAX_FAILS


def note_fail(key):
    with _fails_lock:
        _fails.setdefault(key, []).append(time.monotonic())


# ---------------------------------------------------------------- endpoints
# Hashing a password takes ~0.1 s and the database calls wait on the network, so that work runs in a
# worker thread (run_in_threadpool) instead of holding up every other request.
@router.post('/signup')
async def signup(request: Request, response: Response):
    body = await json_body(request)
    if body is None:
        return bad('Send the form as JSON.', 415)
    email = str(body.get('email', '')).strip()
    name = str(body.get('name', '')).strip()
    password = str(body.get('password', ''))
    if not EMAIL_RE.match(email) or len(email) > 254:
        return bad('Please enter a valid email address.')
    if len(name) > 60:
        return bad('Please keep your name under 60 characters.')
    age, error = parse_age(body.get('age', ''))
    if error:
        return bad(error)
    if len(password) < 8:
        return bad('Please use a password of at least 8 characters.')
    if len(password) > 128:
        return bad('Please keep your password under 128 characters.')

    def work():
        pw_hash = hash_password(password)
        with connect() as conn:
            try:
                user_id = conn.execute('INSERT INTO users (email, name, password_hash, birth_year) VALUES (%s, %s, %s, %s) '
                                       'RETURNING id', (email, name, pw_hash, datetime.now().year - age)).fetchone()[0]
            except psycopg.errors.UniqueViolation:
                return bad('An account with this email already exists. Try logging in instead.', 409)
            start_session(conn, user_id, request, response)
            return {'ok': True, 'user': user_by_id(conn, user_id)}
    try:
        return await run_in_threadpool(work)
    except psycopg.OperationalError:
        return db_down()


@router.post('/login')
async def login(request: Request, response: Response):
    body = await json_body(request)
    if body is None:
        return bad('Send the form as JSON.', 415)
    email = str(body.get('email', '')).strip()
    password = str(body.get('password', ''))[:128]
    key = (request.client.host if request.client else '?', email.lower())
    if too_many(key):
        return bad('Too many attempts. Please wait 15 minutes and try again.', 429)

    def work():
        with connect() as conn:
            row = conn.execute('SELECT id, password_hash FROM users WHERE lower(email) = lower(%s)', (email,)).fetchone()
            if not check_password(password, row[1] if row else _DUMMY_HASH) or row is None:
                note_fail(key)
                return bad('Email or password is incorrect.', 401)
            conn.execute('DELETE FROM sessions WHERE user_id = %s AND expires_at <= now()', (row[0],))
            start_session(conn, row[0], request, response)
            return {'ok': True, 'user': user_by_id(conn, row[0])}
    try:
        return await run_in_threadpool(work)
    except psycopg.OperationalError:
        return db_down()


@router.post('/logout')
def logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    response.delete_cookie(COOKIE, path='/')
    if token:
        try:
            with connect() as conn:
                conn.execute('DELETE FROM sessions WHERE token_hash = %s', (token_hash(token),))
        except psycopg.OperationalError:
            pass                    # the cookie is gone either way; the stale session expires on its own
    return {'ok': True}


@router.get('/me')
def me(request: Request):
    try:
        with connect() as conn:
            return {'ok': True, 'user': current_user(conn, request)}
    except psycopg.OperationalError:
        return db_down()


@router.patch('/me')
async def update_me(request: Request):
    """Change the logged-in user's age and/or name."""
    body = await json_body(request)
    if body is None:
        return bad('Send the form as JSON.', 415)
    changes = {}
    if 'age' in body:
        age, error = parse_age(body['age'])
        if error:
            return bad(error)
        changes['birth_year'] = datetime.now().year - age
    if 'name' in body:
        name = str(body['name']).strip()
        if len(name) > 60:
            return bad('Please keep your name under 60 characters.')
        changes['name'] = name
    if not changes:
        return bad('Nothing to change.')

    def work():
        with connect() as conn:
            row = session_user(conn, request)
            if row is None:
                return bad('Please log in first.', 401)
            for column, value in changes.items():          # column names come from the fixed keys above
                conn.execute(f'UPDATE users SET {column} = %s WHERE id = %s', (value, row[0]))
            return {'ok': True, 'user': user_by_id(conn, row[0])}
    try:
        return await run_in_threadpool(work)
    except psycopg.OperationalError:
        return db_down()
