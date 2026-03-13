"""AGS v3 — WebSocket Connection Manager"""

from fastapi import WebSocket
from typing import Dict, List
import json


class ConnectionManager:
    def __init__(self):
        self.connections: Dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        self.connections[client_id] = websocket
        print(f"[WS] Admin connected: {client_id} ({len(self.connections)} total)")

    def disconnect(self, client_id: str):
        self.connections.pop(client_id, None)
        print(f"[WS] Admin disconnected: {client_id}")

    async def broadcast(self, message: dict):
        """Broadcast to all connected admin dashboard clients"""
        dead = []
        for client_id, ws in self.connections.items():
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(client_id)
        for d in dead:
            self.connections.pop(d, None)

    async def send_to(self, client_id: str, message: dict):
        ws = self.connections.get(client_id)
        if ws:
            try:
                await ws.send_json(message)
            except Exception:
                self.connections.pop(client_id, None)

    def active_count(self) -> int:
        return len(self.connections)
