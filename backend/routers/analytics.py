"""AGS v3 — Analytics Router"""

from fastapi import APIRouter, Request
from models.database import get_analytics_overview, get_all_students, get_student_events

router = APIRouter()


@router.get("/analytics/overview")
async def analytics_overview():
    overview = await get_analytics_overview()
    return overview


@router.get("/analytics/risk-distribution")
async def risk_distribution():
    students = await get_all_students()
    dist = {"SAFE": 0, "LOW_RISK": 0, "SUSPICIOUS": 0, "HIGH_RISK": 0}
    for s in students:
        level = s.get('risk_level', 'SAFE')
        dist[level] = dist.get(level, 0) + 1
    return dist


@router.get("/analytics/violation-heatmap")
async def violation_heatmap():
    """Return hourly violation counts for heatmap"""
    students = await get_all_students()
    hourly = {str(h).zfill(2): 0 for h in range(24)}

    for s in students:
        events = await get_student_events(s['student_id'], 200)
        for e in events:
            if e.get('severity') != 'INFO':
                try:
                    from datetime import datetime
                    dt   = datetime.fromisoformat(e['timestamp'].replace('Z',''))
                    hour = str(dt.hour).zfill(2)
                    hourly[hour] = hourly.get(hour, 0) + 1
                except: pass

    return hourly
