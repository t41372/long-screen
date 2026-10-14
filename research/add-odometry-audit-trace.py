#!/usr/bin/env python3
"""Add native-only diagnostic output for models rejected before native refinement."""

from pathlib import Path

TARGET = Path("rust/long-screen/src/kernels/track/odometry.rs")


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one source match, found {count}")
    return source.replace(old, new, 1)


source = TARGET.read_text(encoding="utf-8")
old_models = r'''    let hypotheses = translation_hypotheses(&match_points, 16);
    let models: Vec<_> = if hypotheses.iter().any(|m| m.support >= MIN_SUPPORT) {
        hypotheses
            .into_iter()
            .filter(|m| m.support >= MIN_SUPPORT)
            .collect()
    } else {
        hypotheses.into_iter().take(FEW_MATCH_MODELS).collect()
    };
'''
new_models = r'''    let hypotheses = translation_hypotheses(&match_points, 16);
    let hypothesis_count = hypotheses.len();
    let models: Vec<_> = if hypotheses.iter().any(|m| m.support >= MIN_SUPPORT) {
        hypotheses
            .into_iter()
            .filter(|m| m.support >= MIN_SUPPORT)
            .collect()
    } else {
        hypotheses.into_iter().take(FEW_MATCH_MODELS).collect()
    };
    #[cfg(not(target_arch = "wasm32"))]
    if std::env::var_os("LONG_SCREEN_TRACE_ODOMETRY").is_some() {
        eprintln!(
            "LS_ODO_BEGIN raw_matches={} hypotheses={} models={}",
            raw_matches.len(),
            hypothesis_count,
            models.len(),
        );
    }
'''
source = replace_once(source, old_models, new_models, "trace odometry model counts")

old_audit = r'''        .map(|m| {
            let audit = audit_translation(previous_gray, g, m.x, m.y, Some(roi), f > 1.0);
            (m, audit)
        })
'''
new_audit = r'''        .map(|m| {
            let audit = audit_translation(previous_gray, g, m.x, m.y, Some(roi), f > 1.0);
            #[cfg(not(target_arch = "wasm32"))]
            if std::env::var_os("LONG_SCREEN_TRACE_ODOMETRY").is_some() {
                eprintln!(
                    concat!(
                        "LS_ODO_AUDIT model=({:.3},{:.3}) support={} confidence={:.6} ambiguous={} ",
                        "overlap={:.6} error={:.6} mismatch={:.6} blocks={} agreeing={} ",
                        "agreement={:.6} agreeing_error={:.6}"
                    ),
                    m.x,
                    m.y,
                    m.support,
                    m.confidence,
                    m.ambiguous,
                    audit.overlap,
                    audit.error,
                    audit.mismatch,
                    audit.blocks,
                    audit.agreeing,
                    audit.agreement,
                    audit.agreeing_error,
                );
            }
            (m, audit)
        })
'''
source = replace_once(source, old_audit, new_audit, "trace rejected odometry audits")
TARGET.write_text(source, encoding="utf-8")
