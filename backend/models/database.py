"""
AGS v3 — Database Models (SQLite via aiosqlite)
"""

import aiosqlite
import json
from datetime import datetime
from typing import Optional, List, Dict, Any

DB_PATH = "ags.db"

# ─────────────────────────────────────────────────────────────────────────────
# Schema
# ─────────────────────────────────────────────────────────────────────────────
CREATE_SCHEMA = """
CREATE TABLE IF NOT EXISTS students (
    student_id      TEXT PRIMARY KEY,
    exam_id         TEXT,
    integrity_score REAL DEFAULT 100,
    violations      INTEGER DEFAULT 0,
    risk_level      TEXT DEFAULT 'SAFE',
    cheat_prob      REAL DEFAULT 0,
    behavior_risk   REAL DEFAULT 0,
    is_active       INTEGER DEFAULT 0,
    start_time      TEXT,
    last_seen       TEXT,
    created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
    id              TEXT PRIMARY KEY,
    student_id      TEXT,
    exam_id         TEXT,
    event_type      TEXT,
    severity        TEXT DEFAULT 'INFO',
    timestamp       TEXT,
    duration        REAL DEFAULT 0,
    metadata        TEXT DEFAULT '{}',
    created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(student_id)
);

CREATE TABLE IF NOT EXISTS exam_sessions (
    session_id      TEXT PRIMARY KEY,
    student_id      TEXT,
    exam_id         TEXT,
    start_time      TEXT,
    end_time        TEXT,
    final_score     REAL,
    total_violations INTEGER,
    cheat_prob      REAL,
    duration_ms     REAL,
    status          TEXT DEFAULT 'active',
    FOREIGN KEY (student_id) REFERENCES students(student_id)
);

CREATE INDEX IF NOT EXISTS idx_events_student  ON events(student_id);
CREATE INDEX IF NOT EXISTS idx_events_type     ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity);
"""


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        for stmt in CREATE_SCHEMA.strip().split(';'):
            stmt = stmt.strip()
            if stmt:
                await db.execute(stmt)
        await db.commit()
    print("[AGS DB] Initialised")


# ─────────────────────────────────────────────────────────────────────────────
# Student operations
# ─────────────────────────────────────────────────────────────────────────────
async def upsert_student(student_id: str, exam_id: str) -> Dict:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        existing = await db.execute("SELECT * FROM students WHERE student_id=?", (student_id,))
        row = await existing.fetchone()

        now = datetime.utcnow().isoformat()
        if row:
            await db.execute("""
                UPDATE students SET exam_id=?, is_active=1, last_seen=?, start_time=?
                WHERE student_id=?
            """, (exam_id, now, now, student_id))
        else:
            await db.execute("""
                INSERT INTO students (student_id, exam_id, is_active, start_time, last_seen)
                VALUES (?,?,1,?,?)
            """, (student_id, exam_id, now, now))
        await db.commit()
    return await get_student(student_id)


async def get_student(student_id: str) -> Optional[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT * FROM students WHERE student_id=?", (student_id,))
        row = await cur.fetchone()
        return dict(row) if row else None


async def get_all_students() -> List[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT * FROM students ORDER BY last_seen DESC")
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


async def update_student_scores(student_id: str, score: float, violations: int,
                                risk_level: str, cheat_prob: float, behavior_risk: float):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            UPDATE students
            SET integrity_score=?, violations=?, risk_level=?,
                cheat_prob=?, behavior_risk=?, last_seen=?
            WHERE student_id=?
        """, (score, violations, risk_level, cheat_prob, behavior_risk,
              datetime.utcnow().isoformat(), student_id))
        await db.commit()


async def deactivate_student(student_id: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE students SET is_active=0 WHERE student_id=?", (student_id,))
        await db.commit()


# ─────────────────────────────────────────────────────────────────────────────
# Event operations
# ─────────────────────────────────────────────────────────────────────────────
async def insert_event(event: Dict) -> Dict:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO events (id, student_id, exam_id, event_type, severity, timestamp, duration, metadata)
            VALUES (?,?,?,?,?,?,?,?)
        """, (
            event.get('id', f"EVT-{datetime.utcnow().timestamp()}"),
            event['student_id'],
            event.get('exam_id', ''),
            event['event_type'],
            event.get('severity', 'INFO'),
            event.get('timestamp', datetime.utcnow().isoformat()),
            event.get('duration', 0),
            json.dumps(event.get('metadata', {}))
        ))
        await db.commit()
    return event


async def get_student_events(student_id: str, limit: int = 200) -> List[Dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("""
            SELECT * FROM events WHERE student_id=?
            ORDER BY timestamp DESC LIMIT ?
        """, (student_id, limit))
        rows = await cur.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d['metadata'] = json.loads(d.get('metadata', '{}'))
            result.append(d)
        return result


async def get_events_filtered(filters: Dict) -> List[Dict]:
    """Flexible event filtering for NLP queries"""
    conditions = []
    params     = []

    if filters.get('event_type'):
        conditions.append("event_type = ?")
        params.append(filters['event_type'])
    if filters.get('severity'):
        conditions.append("severity = ?")
        params.append(filters['severity'])
    if filters.get('student_id'):
        conditions.append("student_id = ?")
        params.append(filters['student_id'])

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute(f"SELECT * FROM events {where} ORDER BY timestamp DESC LIMIT 500", params)
        rows = await cur.fetchall()
        return [dict(r) for r in rows]


async def get_analytics_overview() -> Dict:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row

        # Total students
        cur = await db.execute("SELECT COUNT(*) as count FROM students")
        total_students = (await cur.fetchone())['count']

        # Active students
        cur = await db.execute("SELECT COUNT(*) as count FROM students WHERE is_active=1")
        active_students = (await cur.fetchone())['count']

        # High risk
        cur = await db.execute("SELECT COUNT(*) as count FROM students WHERE risk_level IN ('HIGH_RISK','SUSPICIOUS')")
        high_risk = (await cur.fetchone())['count']

        # Total violations
        cur = await db.execute("SELECT COUNT(*) as count FROM events WHERE severity != 'INFO'")
        total_violations = (await cur.fetchone())['count']

        # Violation breakdown
        cur = await db.execute("""
            SELECT event_type, COUNT(*) as count
            FROM events WHERE severity != 'INFO'
            GROUP BY event_type ORDER BY count DESC LIMIT 10
        """)
        breakdown = {r['event_type']: r['count'] for r in await cur.fetchall()}

        # Average cheat probability
        cur = await db.execute("SELECT AVG(cheat_prob) as avg FROM students WHERE is_active=1")
        avg_cheat = (await cur.fetchone())['avg'] or 0

        return {
            "total_students":   total_students,
            "active_students":  active_students,
            "high_risk_count":  high_risk,
            "total_violations": total_violations,
            "avg_cheat_prob":   round(avg_cheat, 1),
            "violation_breakdown": breakdown
        }
