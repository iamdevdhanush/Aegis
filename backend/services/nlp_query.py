"""
AGS v3 — NLP Admin Query Engine
Parses natural language queries into structured filters and executes them.
"""

import re
from typing import Dict, Any, List


class NLPQueryEngine:
    """
    Parses natural language admin queries.

    Examples:
    - "show high risk students"
    - "who switched tabs more than 5 times"
    - "students with multiple face detection"
    - "show students with cheat probability above 70"
    - "list suspicious students"
    """

    RISK_KEYWORDS = {
        'high risk':    'HIGH_RISK',
        'high-risk':    'HIGH_RISK',
        'suspicious':   'SUSPICIOUS',
        'low risk':     'LOW_RISK',
        'safe':         'SAFE',
        'critical':     'CRITICAL',
        'clean':        'CLEAN'
    }

    EVENT_KEYWORDS = {
        'tab switch':       'TAB_SWITCH',
        'tab switching':    'TAB_SWITCH',
        'switched tab':     'TAB_SWITCH',
        'face':             'FACE_NOT_DETECTED',
        'face detection':   'MULTIPLE_FACE_DETECTED',
        'multiple face':    'MULTIPLE_FACE_DETECTED',
        'fullscreen':       'EXIT_FULLSCREEN',
        'copy':             'COPY_ATTEMPT',
        'clipboard':        'COPY_ATTEMPT',
        'devtools':         'DEVTOOLS_OPEN',
        'screen capture':   'SCREEN_CAPTURE_ATTEMPT',
        'keyboard':         'KEYBOARD_SHORTCUT',
        'voice':            'VOICE_DETECTED',
        'camera':           'CAMERA_DISABLED'
    }

    def parse(self, query: str) -> Dict[str, Any]:
        """Parse a natural language query into a structured filter dict"""
        q = query.lower().strip()
        filters = {
            "type":         "STUDENT_FILTER",
            "risk_levels":  [],
            "event_types":  [],
            "min_count":    None,
            "min_cheat":    None,
            "sort_by":      "risk",
            "limit":        50,
            "raw_query":    query
        }

        # Risk level detection
        for keyword, level in self.RISK_KEYWORDS.items():
            if keyword in q:
                if level not in filters["risk_levels"]:
                    filters["risk_levels"].append(level)

        # Event type detection
        for keyword, etype in self.EVENT_KEYWORDS.items():
            if keyword in q:
                if etype not in filters["event_types"]:
                    filters["event_types"].append(etype)

        # Number extraction (e.g., "more than 5 times", "above 70")
        num_match = re.search(r'(?:more than|above|greater than|over|>)\s*(\d+)', q)
        if num_match:
            n = int(num_match.group(1))
            if any(k in q for k in ['cheat', 'probability', 'prob', '%']):
                filters["min_cheat"] = n
            else:
                filters["min_count"] = n

        # Sort detection
        if 'worst' in q or 'highest' in q or 'most' in q:
            filters["sort_by"] = "cheat_prob"
        elif 'recent' in q or 'latest' in q or 'new' in q:
            filters["sort_by"] = "last_seen"

        return filters

    def execute(self, filters: Dict, students: List[Dict]) -> Dict[str, Any]:
        """Execute parsed filters against student list"""
        result = list(students)

        # Filter by risk level
        if filters.get("risk_levels"):
            result = [s for s in result if s.get('risk_level') in filters["risk_levels"]]

        # Filter by cheat probability
        if filters.get("min_cheat") is not None:
            result = [s for s in result if s.get('cheat_prob', 0) >= filters["min_cheat"]]

        # Sort
        sort_by = filters.get("sort_by", "risk")
        if sort_by == "cheat_prob":
            result.sort(key=lambda s: s.get('cheat_prob', 0), reverse=True)
        elif sort_by == "last_seen":
            result.sort(key=lambda s: s.get('last_seen', ''), reverse=True)
        else:
            risk_order = {"HIGH_RISK": 0, "SUSPICIOUS": 1, "LOW_RISK": 2, "SAFE": 3}
            result.sort(key=lambda s: risk_order.get(s.get('risk_level', 'SAFE'), 4))

        # Limit
        limit  = filters.get("limit", 50)
        result = result[:limit]

        return {
            "students": result,
            "count":    len(result),
            "filters":  filters
        }
