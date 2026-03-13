"""
AGS v3 — AI Scoring Engine
Computes cheating probability, behavior risk, integrity confidence
"""

import math
from typing import Dict, Any


class AIEngine:
    """
    Multi-signal AI scoring engine for exam integrity.
    Input: student session data + event counters
    Output: cheating probability (0-100), behavior risk, integrity confidence
    """

    SIGNAL_WEIGHTS = {
        'tab_switch_rate':    0.25,   # tabs per minute
        'keyboard_shortcuts': 0.15,
        'fullscreen_exits':   0.20,
        'face_absence_rate':  0.20,
        'multiple_faces':     0.15,
        'screen_capture':     0.30,
        'devtools_open':      0.25,
        'score_loss':         0.40,
        'violation_density':  0.20
    }

    def compute_scores(self, student: Dict[str, Any]) -> Dict[str, Any]:
        """
        Compute AI scores from current student state.
        Returns dict with cheating_probability, behavior_risk_score, etc.
        """
        score      = student.get('integrity_score', 100)
        violations = student.get('violations', 0)

        # Derive signals from available data
        score_loss         = max(0, 100 - score)
        violation_density  = min(violations * 2, 40)

        # Weighted composite
        raw = (
            score_loss         * self.SIGNAL_WEIGHTS['score_loss'] +
            violation_density  * self.SIGNAL_WEIGHTS['violation_density']
        )

        cheating_probability = min(100, round(raw))
        behavior_risk_score  = min(100, round(violations * 3))

        risk_level = (
            'HIGH_RISK'  if score < 50  else
            'SUSPICIOUS' if score < 75  else
            'LOW_RISK'   if score < 90  else
            'SAFE'
        )

        integrity_confidence = max(0, 100 - cheating_probability)

        return {
            'integrity_score':      score,
            'cheating_probability': cheating_probability,
            'behavior_risk_score':  behavior_risk_score,
            'integrity_confidence': integrity_confidence,
            'risk_level':           risk_level
        }

    def compute_from_counters(self, counters: Dict, elapsed_minutes: float, integrity_score: float) -> Dict:
        """
        Full AI scoring from detailed event counters.
        Used when extension sends full counter payload.
        """
        elapsed = max(elapsed_minutes, 0.1)

        # Rate-based signals
        tab_switch_rate   = counters.get('tab_switches', 0) / elapsed
        face_absence_rate = counters.get('face_events', 0) / elapsed

        signals = {
            'tab_switch_rate':    min(tab_switch_rate * 10,    25),
            'keyboard_shortcuts': min(counters.get('keyboard_attempts', 0) * 3, 15),
            'fullscreen_exits':   min(counters.get('fullscreen_exits', 0) * 5, 20),
            'face_absence_rate':  min(face_absence_rate * 8,   20),
            'multiple_faces':     min(counters.get('multiple_faces', 0) * 8, 16),
            'screen_capture':     min(counters.get('screen_capture', 0) * 15, 30),
            'devtools_open':      min(counters.get('devtools_opens', 0) * 10, 20),
            'score_loss':         max(0, 100 - integrity_score) * 0.4,
            'violation_density':  min(sum(counters.values()) * 0.5, 20)
        }

        raw_prob = sum(
            signals[k] * self.SIGNAL_WEIGHTS.get(k, 1.0)
            for k in signals
        )

        cheating_probability = min(100, round(raw_prob))
        behavior_risk_score  = min(100, round(sum(counters.values()) * 1.5))
        integrity_confidence = max(0, 100 - cheating_probability)

        risk_level = (
            'HIGH_RISK'  if integrity_score < 50  else
            'SUSPICIOUS' if integrity_score < 75  else
            'LOW_RISK'   if integrity_score < 90  else
            'SAFE'
        )

        return {
            'cheating_probability': cheating_probability,
            'behavior_risk_score':  behavior_risk_score,
            'integrity_confidence': integrity_confidence,
            'risk_level':           risk_level,
            'signals':              signals
        }

    def detect_anomaly(self, recent_velocity: float, baseline_velocity: float) -> bool:
        """
        Detect behavior anomaly: current velocity deviates > 2x from baseline
        """
        if baseline_velocity <= 0:
            return False
        return abs(recent_velocity - baseline_velocity) > baseline_velocity * 2
