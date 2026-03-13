"""AGS v3 — Exam Lifecycle Router"""

from fastapi import APIRouter, Request
from pydantic import BaseModel
from typing import Optional
from datetime import datetime

from models.database import upsert_student, deactivate_student, insert_event

router = APIRouter()


class ExamStart(BaseModel):
    student_id: str
    exam_id:    str
    timestamp:  Optional[str] = None


class ExamEnd(BaseModel):
    student_id:           str
    exam_id:              str
    final_score:          Optional[float] = 100
    total_violations:     Optional[int]   = 0
    cheating_probability: Optional[float] = 0
    duration_ms:          Optional[float] = 0


@router.post("/exam/start")
async def exam_start(payload: ExamStart, request: Request):
    manager = request.app.state.manager
    student = await upsert_student(payload.student_id, payload.exam_id)

    await insert_event({
        "id":         f"EVT-START-{payload.student_id}",
        "student_id": payload.student_id,
        "exam_id":    payload.exam_id,
        "event_type": "EXAM_STARTED",
        "severity":   "INFO",
        "timestamp":  payload.timestamp or datetime.utcnow().isoformat(),
        "metadata":   {}
    })

    await manager.broadcast({
        "type":      "STUDENT_JOINED",
        "student":   student,
        "timestamp": payload.timestamp or datetime.utcnow().isoformat()
    })

    return {"ok": True, "student": student}


@router.post("/exam/end")
async def exam_end(payload: ExamEnd, request: Request):
    manager = request.app.state.manager

    await insert_event({
        "id":         f"EVT-END-{payload.student_id}",
        "student_id": payload.student_id,
        "exam_id":    payload.exam_id,
        "event_type": "EXAM_ENDED",
        "severity":   "INFO",
        "timestamp":  datetime.utcnow().isoformat(),
        "metadata": {
            "final_score":         payload.final_score,
            "total_violations":    payload.total_violations,
            "cheating_probability": payload.cheating_probability,
            "duration_ms":         payload.duration_ms
        }
    })

    await deactivate_student(payload.student_id)

    await manager.broadcast({
        "type":       "STUDENT_LEFT",
        "student_id": payload.student_id,
        "final_score": payload.final_score,
        "cheat_prob":  payload.cheating_probability
    })

    return {"ok": True}
