// Aegis v2 — Analytics Engine
// Violation pattern analysis, risk profiling, and admin-facing insights

export class AnalyticsEngine {
  constructor() {
    this.WEIGHTS = {
      FACE_NOT_DETECTED: 3.0,
      EXIT_FULLSCREEN:   2.5,
      MULTIPLE_FACES:    2.5,
      COPY_ATTEMPT:      2.0,
      MULTIPLE_TABS:     2.0,
      PAGE_REFRESH:      1.8,
      TAB_SWITCH:        1.5,
      VOICE_DETECTED:    1.5,
      KEYBOARD_SHORTCUT: 1.2,
      WINDOW_BLUR:       1.0,
      PASTE_ATTEMPT:     1.0,
      RIGHT_CLICK:       0.5,
      CAMERA_DISABLED:   3.0,
      MIC_DISABLED:      2.0
    };
  }

  // ── Summarise raw events into per-type counts ───────────────────────────

  summarise(events) {
    const counts = {};
    events.forEach(e => {
      if (e.severity !== 'INFO') counts[e.eventType] = (counts[e.eventType] || 0) + 1;
    });
    return counts;
  }

  // ── Full analytics report ───────────────────────────────────────────────

  report(events, integrityScore) {
    const violations = events.filter(e => e.severity !== 'INFO');
    const counts     = this.summarise(events);
    const weighted   = this._weightedRisk(counts);
    const profile    = this._riskProfile(weighted, integrityScore, violations.length);
    const timeline   = this._buildTimeline(violations);
    const patterns   = this._detectPatterns(violations);

    return {
      summary: {
        totalEvents:      events.length,
        totalViolations:  violations.length,
        integrityScore,
        riskScore:        Math.round(weighted),
        riskProfile:      profile,
        sessionDuration:  this._duration(events)
      },
      breakdown:  counts,
      patterns,
      timeline,
      topViolations: this._topViolations(counts, 5),
      generated: new Date().toISOString()
    };
  }

  // ── Risk profiling ──────────────────────────────────────────────────────

  _weightedRisk(counts) {
    let score = 0;
    for (const [type, count] of Object.entries(counts)) {
      const w = this.WEIGHTS[type] || 1.0;
      // Diminishing returns: log scale for repeat violations
      score += w * (1 + Math.log(count));
    }
    return score;
  }

  _riskProfile(weightedScore, integrityScore, violationCount) {
    // Composite score: blend integrity loss + weighted violation severity
    const composite = (100 - integrityScore) * 0.6 + weightedScore * 2 + violationCount * 0.5;
    if (composite < 10)  return 'CLEAN';
    if (composite < 25)  return 'LOW_RISK';
    if (composite < 50)  return 'SUSPICIOUS';
    if (composite < 80)  return 'HIGH_RISK';
    return 'CRITICAL';
  }

  // ── Pattern detection ───────────────────────────────────────────────────

  _detectPatterns(violations) {
    const patterns = [];

    // Cluster: multiple tab switches within short window
    const tabSwitches = violations.filter(v => v.eventType === 'TAB_SWITCH');
    if (tabSwitches.length >= 3) {
      patterns.push({
        type: 'REPEATED_TAB_SWITCHING',
        count: tabSwitches.length,
        severity: 'HIGH',
        description: `${tabSwitches.length} tab switches detected — possible resource consultation.`
      });
    }

    // Cluster: copy+paste pairing
    const copies = violations.filter(v => v.eventType === 'COPY_ATTEMPT').length;
    const pastes = violations.filter(v => v.eventType === 'PASTE_ATTEMPT').length;
    if (copies > 0 && pastes > 0) {
      patterns.push({
        type: 'COPY_PASTE_PAIR',
        count: Math.min(copies, pastes),
        severity: 'HIGH',
        description: 'Copy and paste events detected together — possible content transfer.'
      });
    }

    // Face repeatedly missing
    const faceAbsent = violations.filter(v => v.eventType === 'FACE_NOT_DETECTED').length;
    if (faceAbsent >= 2) {
      patterns.push({
        type: 'REPEATED_FACE_ABSENCE',
        count: faceAbsent,
        severity: 'HIGH',
        description: `Face absent ${faceAbsent} times — student may have left the device.`
      });
    }

    // Fullscreen repeatedly exited
    const fsExits = violations.filter(v => v.eventType === 'EXIT_FULLSCREEN').length;
    if (fsExits >= 2) {
      patterns.push({
        type: 'REPEATED_FULLSCREEN_EXIT',
        count: fsExits,
        severity: 'MEDIUM',
        description: `Fullscreen exited ${fsExits} times — possible external resource access.`
      });
    }

    return patterns;
  }

  // ── Utilities ───────────────────────────────────────────────────────────

  _buildTimeline(violations) {
    return violations.slice(-50).map(v => ({
      time:      v.hhmm || new Date(v.timestamp).toTimeString().substr(0,5),
      eventType: v.eventType,
      severity:  v.severity
    }));
  }

  _topViolations(counts, n) {
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([type, count]) => ({ type, count, weight: this.WEIGHTS[type] || 1.0 }));
  }

  _duration(events) {
    if (events.length < 2) return 0;
    return new Date(events.at(-1).timestamp) - new Date(events[0].timestamp);
  }

  // ── B2B export (for admin dashboards) ──────────────────────────────────

  exportForDashboard(report) {
    return {
      studentId:      report.studentId,
      examId:         report.examId,
      integrityScore: report.summary.integrityScore,
      riskProfile:    report.summary.riskProfile,
      violations:     report.summary.totalViolations,
      patterns:       report.patterns.map(p => p.type),
      topViolations:  report.topViolations,
      timestamp:      report.generated
    };
  }
}
