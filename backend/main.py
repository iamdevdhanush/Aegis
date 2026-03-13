"""
AGS v3 — FastAPI Backend
AI-powered exam integrity platform backend
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import uvicorn
import asyncio
import json
from datetime import datetime
from typing import Optional

from routers import events, students, analytics, exam
from services.connection_manager import ConnectionManager
from services.ai_engine import AIEngine
from models.database import init_db

app = FastAPI(
    title="AGS — AI Guardrail System",
    description="AI-powered exam integrity monitoring platform",
    version="3.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global connection manager for WebSocket clients (admin dashboard)
manager = ConnectionManager()
ai_engine = AIEngine()

# Inject shared state into routers
app.state.manager   = manager
app.state.ai_engine = ai_engine

# Include routers
app.include_router(events.router,    tags=["Events"])
app.include_router(students.router,  tags=["Students"])
app.include_router(analytics.router, tags=["Analytics"])
app.include_router(exam.router,      tags=["Exam"])

# Serve dashboard static files
import os
if os.path.exists("../dashboard"):
    app.mount("/dashboard", StaticFiles(directory="../dashboard", html=True), name="dashboard")


@app.on_event("startup")
async def startup():
    await init_db()
    print("[AGS Backend] Started — AI Guardrail System v3.0")


@app.get("/")
async def root():
    return {
        "system": "AGS — AI Guardrail System",
        "version": "3.0.0",
        "status": "operational",
        "endpoints": ["/events", "/exam/start", "/exam/end", "/students", "/analytics/overview", "/ws/{client_id}"]
    }


@app.get("/health")
async def health():
    return {"status": "ok", "timestamp": datetime.utcnow().isoformat()}


# ─────────────────────────────────────────────────────────────────────────────
# WebSocket — Live admin dashboard streaming
# ─────────────────────────────────────────────────────────────────────────────
@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await manager.connect(websocket, client_id)
    try:
        while True:
            data = await websocket.receive_text()
            msg  = json.loads(data)

            # NLP admin query
            if msg.get("type") == "NLP_QUERY":
                result = await handle_nlp_query(msg.get("query", ""), websocket)
                await websocket.send_json(result)

            elif msg.get("type") == "PING":
                await websocket.send_json({"type": "PONG", "ts": datetime.utcnow().isoformat()})

    except WebSocketDisconnect:
        manager.disconnect(client_id)
    except Exception as e:
        print(f"[WS Error] {client_id}: {e}")
        manager.disconnect(client_id)


async def handle_nlp_query(query: str, ws: WebSocket):
    """Simple NLP query parser for admin queries"""
    from services.nlp_query import NLPQueryEngine
    from models.database import get_all_students, get_events_filtered

    engine = NLPQueryEngine()
    parsed = engine.parse(query)

    students = await get_all_students()
    result   = engine.execute(parsed, students)

    return {
        "type":   "NLP_RESULT",
        "query":  query,
        "parsed": parsed,
        "result": result
    }


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
