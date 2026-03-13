"""AGS v3 — Events Router"""

from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any, List
from datetime import datetime
import uuid

from models.database import insert_event, update_student_scores, get_student, upsert_student
from services.ai_engine import AIEngine

router = APIRouter()


class EventPayload(BaseModel):
    student_id: str
    exam_id:    str
    event_type: str
    timestamp:  Optional[str]  = None
    duration:   Optional[float] = 0
    metadata:   Optional[Dict[str, Any]] = {}


class BatchPayload(BaseModel):
    events: List[EventPayload]


SEVERITY_HIGH   = {
    'MULTIPLE_TABS','MULTIPLE_FACE_DETECTED','COPY_ATTEMPT','PAGE_REFRESH',
    'CAMERA_DISABLED','EXIT_FULLSCREEN','FACE_NOT_DETECTED',
    'SCREEN_CAPTURE_ATTEMPT','DEVTOOLS_OPEN','OVERLAY_EXTENSION_DETECTED'
}
SEVERITY_MEDIUM = {
    'TAB_SWITCH','WINDOW_BLUR','VOICE_DETECTED','KEYBOARD_SHORTCUT',
    'PASTE_ATTEMPT','BEHAVIOR_ANOMALY','IDLE','WINDOW_RESIZE'
}


def classify_severity(event_type: str) -> str:
    if event_type in SEVERITY_HIGH:   return 'HIGH'
    if event_type in SEVERITY_MEDIUM: return 'MEDIUM'
    if event_type in {'EXAM_STARTED', 'EXAM_ENDED', 'CAMERA_STARTED', 'MIC_STARTED'}: return 'INFO'
    return 'LOW'


@router.post("/events")
async def receive_event(payload: EventPayload, request: Request):
    """Receive a single monitoring event from the extension"""
    manager    = request.app.state.manager
    ai_engine  = request.app.state.ai_engine

    severity = classify_severity(payload.event_type)
    event_id = f"EVT-{uuid.uuid4().hex[:8].upper()}"
    ts       = payload.timestamp or datetime.utcnow().isoformat()

    event_doc = {
        "id":         event_id,
        "student_id": payload.student_id,
        "exam_id":    payload.exam_id,
        "event_type": payload.event_type,
        "severity":   severity,
        "timestamp":  ts,
        "duration":   payload.duration,
        "metadata":   payload.metadata or {}
    }

    await insert_event(event_doc)

    # Update AI scores
    student = await get_student(payload.student_id)
    if student and severity != 'INFO':
        scores = ai_engine.compute_scores(student)
        await update_student_scores(
            payload.student_id,
            scores['integrity_score'],
            student.get('violations', 0) + 1,
            scores['risk_level'],
            scores['cheating_probability'],
            scores['behavior_risk_score']
        )

    # Broadcast to admin dashboard via WebSocket
    await manager.broadcast({
        "type":    "NEW_EVENT",
        "event":   event_doc,
        "student": await get_student(payload.student_id)
    })

    return {"ok": True, "id": event_id, "severity": severity}


@router.post("/events/batch")
async def receive_batch(payload: BatchPayload, request: Request):
    """Receive a batch of events"""
    manager = request.app.state.manager
    results = []

    for ev in payload.events:
        severity = classify_severity(ev.event_type)
        doc = {
            "id":         f"EVT-{uuid.uuid4().hex[:8].upper()}",
            "student_id": ev.student_id,
            "exam_id":    ev.exam_id,
            "event_type": ev.event_type,
            "severity":   severity,
            "timestamp":  ev.timestamp or datetime.utcnow().isoformat(),
            "duration":   ev.duration,
            "metadata":   ev.metadata or {}
        }
        await insert_event(doc)
        results.append(doc['id'])

    await manager.broadcast({"type": "BATCH_EVENTS", "count": len(results)})
    return {"ok": True, "processed": len(results), "ids": results}


@router.post("/heartbeat")
async def heartbeat(payload: Dict, request: Request):
    """Session heartbeat from extension"""
    manager = request.app.state.manager
    student_id = payload.get("studentId")

    if student_id:
        student = await get_student(student_id)
        if student:
            await update_student_scores(
                student_id,
                payload.get("integrityScore", student['integrity_score']),
                student.get('violations', 0),
                student.get('risk_level', 'SAFE'),
                payload.get("cheatingProbability", student['cheat_prob']),
                student.get('behavior_risk', 0)
            )
            await manager.broadcast({
                "type":      "HEARTBEAT",
                "studentId": student_id,
                "score":     payload.get("integrityScore"),
                "cheatProb": payload.get("cheatingProbability"),
                "ts":        payload.get("ts")
            })

    return {"ok": True}
