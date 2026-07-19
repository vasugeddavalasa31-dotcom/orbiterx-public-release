use orbiterx_analytics::CompactionImplementation;
use orbiterx_analytics::CompactionReason;
use orbiterx_otel::SessionTelemetry;
use orbiterx_protocol::error::OrbiterXErr;
use tracing::warn;

/// Retries failures that may be model-specific and succeed with a different model.
pub(crate) fn should_retry_with_current_model(error: &OrbiterXErr) -> bool {
    matches!(
        error,
        OrbiterXErr::InvalidRequest(_)
            | OrbiterXErr::UnexpectedStatus(_)
            | OrbiterXErr::ContextWindowExceeded
            | OrbiterXErr::UsageLimitReached(_)
            | OrbiterXErr::ServerOverloaded
            | OrbiterXErr::InternalServerError
            | OrbiterXErr::RetryLimit(_)
    )
}

pub(crate) fn record_model_fallback(
    session_telemetry: &SessionTelemetry,
    previous_model: &str,
    current_model: &str,
    reason: CompactionReason,
    implementation: CompactionImplementation,
    fallback_error: Option<&OrbiterXErr>,
) {
    let reason_tag = match reason {
        CompactionReason::UserRequested => "user_requested",
        CompactionReason::ContextLimit => "context_limit",
        CompactionReason::ModelDownshift => "model_downshift",
        CompactionReason::CompHashChanged => "comp_hash_changed",
    };
    let implementation_tag = match implementation {
        CompactionImplementation::Responses => "responses",
        CompactionImplementation::ResponsesCompactionV2 => "responses_compaction_v2",
        CompactionImplementation::ResponsesCompact => "responses_compact",
    };
    let outcome = if fallback_error.is_none() {
        "succeeded"
    } else {
        "failed"
    };
    session_telemetry.counter(
        "orbiterx.compaction.model_fallback",
        /*inc*/ 1,
        &[
            ("reason", reason_tag),
            ("implementation", implementation_tag),
            ("outcome", outcome),
        ],
    );
    warn!(
        previous_model,
        current_model,
        ?reason,
        ?implementation,
        outcome,
        ?fallback_error,
        "previous-model compaction failed; retried with current model"
    );
}
