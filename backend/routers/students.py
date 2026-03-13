"""AGS v3 — Students Router"""

from fastapi import APIRouter, HTTPException
from models.database import get_all_students, get_student, get_student_events

router = APIRouter()


@router.get("/students")
async def list_students():
    students = await get_all_students()
    return {"students": students, "count": len(students)}


@router.get("/students/{student_id}")
async def get_student_detail(student_id: str):
    student = await get_student(student_id)
    if not student:
        raise HTTPException(404, f"Student {student_id} not found")
    return student


@router.get("/students/{student_id}/events")
async def get_student_event_log(student_id: str, limit: int = 100):
    student = await get_student(student_id)
    if not student:
        raise HTTPException(404, f"Student {student_id} not found")
    events = await get_student_events(student_id, limit)
    return {"student_id": student_id, "events": events, "count": len(events)}


@router.get("/students/{student_id}/report")
async def get_integrity_report(student_id: str):
    """Generate integrity report for a student"""
    student = await get_student(student_id)
    if not student:
        raise HTTPException(404, f"Student {student_id} not found")

    events = await get_student_events(student_id, 500)
    violations = [e for e in events if e['severity'] != 'INFO']

    # Violation breakdown
    breakdown = {}
    for v in violations:
        breakdown[v['event_type']] = breakdown.get(v['event_type'], 0) + 1

    # Timeline (last 50 violations)
    timeline = [
        {"time": e['timestamp'], "event": e['event_type'], "severity": e['severity']}
        for e in violations[-50:]
    ]

    # Risk classification
    cheat_prob = student.get('cheat_prob', 0)
    risk_class = (
        "CRITICAL"    if cheat_prob >= 80 else
        "HIGH_RISK"   if cheat_prob >= 60 else
        "SUSPICIOUS"  if cheat_prob >= 40 else
        "LOW_RISK"    if cheat_prob >= 20 else
        "CLEAN"
    )

    return {
        "student_id":        student_id,
        "exam_id":           student.get('exam_id'),
        "integrity_score":   student.get('integrity_score', 100),
        "cheating_probability": cheat_prob,
        "behavior_risk":     student.get('behavior_risk', 0),
        "risk_classification": risk_class,
        "total_violations":  len(violations),
        "violation_breakdown": breakdown,
        "session_timeline":  timeline,
        "generated_at":      __import__('datetime').datetime.utcnow().isoformat()
    }
